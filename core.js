(function () {
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const MAX_FRAMES = 6;
const AI_TIMEOUT_MS = 180000;
const SELECTION_TIMEOUT_MS = 8000;
const FFMPEG_TIMEOUT_MS = 180000;
const ANNOTATION_START = "[AI Video Tagger:start]";
const ANNOTATION_END = "[AI Video Tagger:end]";

function appError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

const MODEL_SETUP_HELP = "请打开 Eagle「偏好设置 → AI模型套件」，为「图片理解」选择能识别图片的模型，不要选图片生成或文字识别模型。";

function friendlyError(error, stage = "") {
  const code = error && error.code;
  const raw = String(error && error.message || error || "");
  const cause = String(error && error.cause && error.cause.message || "");
  const text = (raw + " " + cause + " " + code + " " + (error && error.cause && error.cause.code || "")).toLowerCase();
  if (code === "VIDEO_UNREADABLE") stage = "extract";
  const status = Number(error && (error.statusCode || error.status || error.cause && error.cause.statusCode));
  const notice = (key, title, message, action = "") => ({ key, title, message, action });
  if (code === "AI_MODEL_UNSET" || code === "AI_MODEL_WRONG") {
    return notice("model-setup", "请先设置图片理解模型", MODEL_SETUP_HELP, "model-settings");
  }
  if (code === "AI_RESULT_INVALID" || /scenes|有效标签|字符串数组|分析对象|摘要为空|区块标识/.test(raw)) {
    return notice("model-result", "AI 没能识别这个视频", "请到 Eagle「偏好设置 → AI模型套件」检查「图片理解」模型；如果已经设置，请换一个图片理解模型后重试。", "model-settings");
  }
  if (code === "AI_UNAVAILABLE") {
    return notice("ai-unavailable", "AI模型套件尚未就绪", "请在 Eagle 插件中心安装或启用「AI模型套件」，再打开本插件。", "model-settings");
  }
  if (code === "SELECTION_UNAVAILABLE") {
    return notice("selection", "暂时读不到所选视频", "请回到 Eagle 重新选中视频，再点「开始分析」。");
  }
  if (code === "FFMPEG_UNAVAILABLE") {
    return notice("ffmpeg", "视频处理工具尚未就绪", "请在 Eagle 插件中心安装或重新启用「FFmpeg」，再试一次。");
  }
  if (code === "VIDEO_MISSING" || code === "ITEM_MISSING") {
    return notice("missing-video", "找不到这个视频", "视频可能已移动或删除。请回到 Eagle 重新选中仍能打开的视频。");
  }
  if (/enospc|no space left|磁盘空间/.test(text)) {
    return notice("disk-full", "磁盘空间不足", "请清理系统盘和资源库所在磁盘的空间，再试一次。");
  }
  if (stage === "save" || code === "SAVE_FAILED") {
    return notice("save", "结果没有保存成功", "请确认 Eagle 资源库可以正常保存修改，再重新分析。");
  }
  if (stage !== "ai" && stage !== "model" && /eacces|eperm|permission denied|权限不足|access denied/.test(text)) {
    return notice("file-access", "暂时无法访问文件", "请确认视频和资源库可以正常打开，且没有被其他程序占用，再重试。");
  }
  if (stage === "ai" || stage === "model") {
    if (/insufficient.quota|quota.exceeded|insufficient.balance|余额不足|额度不足/.test(text)) {
      return notice("quota", "AI服务的额度不足", "请检查模型服务账户的余额或剩余额度，再试一次。", "model-settings");
    }
    if (status === 401 || status === 403 || /unauthorized|authentication|invalid.api.key|api.key.*invalid|forbidden/.test(text)) {
      return notice("authentication", "AI服务验证失败", "请到「偏好设置 → AI模型套件」检查服务密钥和账户权限。", "model-settings");
    }
    if (status === 429 || /rate.limit|too many requests/.test(text)) {
      return notice("busy", "AI服务现在比较忙", "请稍等片刻，再重新分析。");
    }
    if (error && error.name === "TimeoutError" || /timeout|timed out|超时/.test(text)) {
      return notice("ai-timeout", "AI等待时间过长", "请检查网络后重试；如果经常出现，请换一个响应更快的图片理解模型。", "model-settings");
    }
    if (/invalid url/.test(text)) return notice("address", "AI服务地址不正确", "请到「偏好设置 → AI模型套件」检查服务地址是否填写正确。", "model-settings");
    if (status === 404 || /model.*not.found|model.*not.support|image.*not.support|model is not valid|provider.*not/.test(text)) {
      return notice("model-setup", "当前模型暂时不能使用", MODEL_SETUP_HELP, "model-settings");
    }
    if (status >= 500) return notice("service", "AI服务暂时不可用", "请稍后再试，或换一个图片理解模型。", "model-settings");
    if (/fetch|network|enotfound|econnrefused|econnreset|eai_again|连接|网络/.test(text)) {
      return notice("connection", "连接不上AI服务", "请检查网络，以及「AI模型套件」里的服务地址，再试一次。", "model-settings");
    }
    return notice("ai-request", "AI这次没有完成分析", "请稍后重试；如果仍然失败，请到「偏好设置 → AI模型套件」检查或更换图片理解模型。", "model-settings");
  }
  if (stage === "extract" || code === "VIDEO_UNREADABLE") {
    if (error && error.name === "TimeoutError") return notice("video-timeout", "这个视频处理得太久了", "请先试一段较短的视频，并检查原视频能否正常播放。");
    if (/enoent|spawn.*not found/.test(text)) return notice("ffmpeg", "视频处理工具尚未就绪", "请在 Eagle 插件中心安装或重新启用「FFmpeg」，再试一次。");
    return notice("video", "暂时无法读取视频画面", "请先确认这个视频能在 Eagle 中正常播放；如果不能，请重新导入或换一个视频。");
  }
  return notice("unexpected", "这次处理没有完成", "请关闭插件后重新打开，再试一次。");
}

function createAbortError() {
  const error = new Error("已取消处理");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw createAbortError();
}

// Also bounds providers which ignore abortSignal. Late results are never used.
function runAbortable(operation, { signal, timeoutMs = 0, timeoutMessage } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(createAbortError());
    const controller = new AbortController();
    let settled = false;
    let timer;

    function finish(error, value, abort = false) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", cancel);
      if (abort) controller.abort();
      if (error) reject(error);
      else resolve(value);
    }

    function cancel() {
      finish(createAbortError(), undefined, true);
    }

    if (signal) signal.addEventListener("abort", cancel, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const error = new Error(timeoutMessage || "操作超时");
        error.name = "TimeoutError";
        finish(error, undefined, true);
      }, timeoutMs);
    }
    Promise.resolve().then(() => {
      throwIfAborted(controller.signal);
      return operation(controller.signal);
    }).then(value => finish(null, value), error => finish(error));
  });
}

function execFilePromise(file, args, options = {}) {
  const { signal, ...execOptions } = options;
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(createAbortError());
    let child;
    const cancel = () => { if (child) child.kill(); };
    if (signal) signal.addEventListener("abort", cancel, { once: true });

    // Wait for execFile's close callback after killing, so cleanup cannot race it.
    const complete = (error, stdout, stderr) => {
      if (signal) signal.removeEventListener("abort", cancel);
      if (signal && signal.aborted) return reject(createAbortError());
      if (error) {
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return reject(new Error("媒体处理日志超过限制"));
        }
        if (error.killed) {
          const timeoutError = new Error("FFmpeg 操作超时，视频文件可能过大或已损坏");
          timeoutError.name = "TimeoutError";
          return reject(timeoutError);
        }
        return reject(new Error(stderr || stdout || error.message));
      }
      resolve({ stdout, stderr });
    };

    try {
      child = execFile(file, args, {
        maxBuffer: 5 * 1024 * 1024,
        timeout: FFMPEG_TIMEOUT_MS,
        windowsHide: true,
        ...execOptions,
      }, complete);
      if (signal && signal.aborted) cancel();
    } catch (error) {
      if (signal) signal.removeEventListener("abort", cancel);
      reject(error);
    }
  });
}

function parseFFmpegError(message) {
  if (/does not contain any stream|matches no streams/.test(message)) {
    return "无法检测到视频流，文件可能已损坏或格式不受支持";
  }
  if (message.includes("Invalid data found when processing input")) {
    return "视频文件数据无效，可能已损坏或格式不受支持";
  }
  if (message.includes("No such file or directory")) return "找不到视频文件，可能已被移动或删除";
  if (message.includes("Permission denied")) return "无法访问视频文件，权限不足";
  return null;
}

async function getVideoDurationSeconds(ffprobePath, inputPath, signal) {
  try {
    const { stdout } = await execFilePromise(ffprobePath, [
      "-v", "error", "-analyzeduration", "100M", "-probesize", "100M",
      "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ], { signal });
    const duration = Number(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  } catch (error) {
    throwIfAborted(signal);
    return 0;
  }
}

function chooseFrameTimes(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return [0];
  const count = Math.min(MAX_FRAMES, Math.max(1, Math.ceil(duration / 3)));
  return Array.from({ length: count }, (_, i) => duration * (i + 0.5) / count);
}

async function extractFrames(ffmpegPath, ffprobePath, inputPath, outputDir, { signal, log = () => {} } = {}) {
  async function attempt(sourcePath, tolerant) {
    throwIfAborted(signal);
    // outputDir belongs to a unique mkdtemp working directory.
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.mkdirSync(outputDir, { recursive: true });
    const duration = await getVideoDurationSeconds(ffprobePath, sourcePath, signal);
    if (!duration) log("无法读取视频时长，尝试提取首个可解码帧...");

    async function extractOne(time, outputPath) {
      throwIfAborted(signal);
      fs.rmSync(outputPath, { force: true });
      const args = ["-y", "-v", "error", "-nostdin", "-analyzeduration", "100M", "-probesize", "100M"];
      if (tolerant) args.push("-err_detect", "ignore_err");
      if (time > 0) args.push("-ss", time.toFixed(6));
      args.push("-i", sourcePath, "-map", "0:v:0", "-an", "-sn", "-frames:v", "1",
        "-vf", "scale=960:-2", "-q:v", "3", "-update", "1", outputPath);
      await execFilePromise(ffmpegPath, args, { signal });
      throwIfAborted(signal);
      return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0;
    }

    const files = [];
    const times = chooseFrameTimes(duration);
    for (let i = 0; i < times.length; i++) {
      const output = path.join(outputDir, `frame-${String(i + 1).padStart(3, "0")}.jpg`);
      if (await extractOne(times[i], output)) files.push(output);
    }
    // A container's duration can extend past its video stream (for example audio).
    if (!files.length && duration > 0) {
      const output = path.join(outputDir, "frame-001.jpg");
      if (await extractOne(0, output)) files.push(output);
    }
    if (!files.length) throw new Error("抽帧失败，没有拿到任何图片。");
    return files;
  }

  try {
    return await attempt(inputPath, false);
  } catch (error) {
    throwIfAborted(signal);
    if (error.name === "TimeoutError") throw error;
    const message = String(error.message || error);
    const hasNonAscii = /[^\x00-\x7F]/.test(inputPath);
    if (!hasNonAscii && !/does not contain any stream|Invalid argument|Invalid data found|matches no streams/.test(message)) {
      throw new Error(parseFFmpegError(message) || message);
    }

    let sourcePath = inputPath;
    if (hasNonAscii) {
      log("首次抽帧失败，正在复制到临时路径重试...");
      const sourceDir = path.join(path.dirname(outputDir), "source");
      fs.mkdirSync(sourceDir, { recursive: true });
      sourcePath = path.join(sourceDir, "video" + path.extname(inputPath));
      const { pipeline } = require("stream/promises");
      await pipeline(fs.createReadStream(inputPath), fs.createWriteStream(sourcePath), { signal });
    } else {
      log("首次抽帧失败，正在尝试容错模式重试...");
    }
    throwIfAborted(signal);
    try {
      return await attempt(sourcePath, true);
    } catch (retryError) {
      throwIfAborted(signal);
      if (retryError.name === "TimeoutError") throw retryError;
      const retryMessage = String(retryError.message || retryError);
      throw new Error(parseFFmpegError(retryMessage) || parseFFmpegError(message) || retryMessage);
    }
  }
}

function normalizeTag(tag) {
  return String(tag).trim().replace(/[，、；;。.!?？]+$/g, "").replace(/\s+/g, " ");
}

function uniqueTags(tags) {
  return [...new Set(tags.map(normalizeTag).filter(tag => tag && tag.length <= 20))];
}

function mergeTags(oldTags = [], newTags = []) {
  const result = [...oldTags];
  const seen = new Set(oldTags.map(normalizeTag));
  for (const tag of uniqueTags(newTags)) {
    if (!seen.has(tag)) {
      result.push(tag);
      seen.add(tag);
    }
  }
  return result;
}

function extractJsonFromText(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const object = trimmed.match(/\{[\s\S]*\}/);
  for (const candidate of [trimmed, fenced && fenced[1], object && object[0]]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch (_) { /* Try the next wrapper. */ }
  }
  return null;
}

function validateAnalysis(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw appError("AI_RESULT_INVALID", "AI 返回的不是有效的分析对象");
  }
  if (typeof parsed.summary !== "string" || !parsed.summary.trim()) {
    throw appError("AI_RESULT_INVALID", "AI 返回的摘要为空或类型错误");
  }
  const result = { summary: parsed.summary.trim() };
  for (const field of ["tags", "scenes", "actions", "shots", "styles"]) {
    const values = field !== "tags" && parsed[field] === undefined ? [] : parsed[field];
    if (!Array.isArray(values) || values.some(value => typeof value !== "string" || !value.trim())) {
      throw appError("AI_RESULT_INVALID", `AI 返回的 ${field} 必须是字符串数组`);
    }
    result[field] = uniqueTags(values);
  }
  if (!result.tags.length) throw appError("AI_RESULT_INVALID", "AI 没有返回有效标签");
  const strings = [result.summary, ...Object.values(result).filter(Array.isArray).flat()];
  if (strings.some(value => value.includes(ANNOTATION_START) || value.includes(ANNOTATION_END))) {
    throw appError("AI_RESULT_INVALID", "AI 返回了保留的区块标识");
  }
  result.tags = uniqueTags([
    ...result.tags, ...result.scenes, ...result.actions, ...result.shots, ...result.styles,
  ]).slice(0, 20);
  return result;
}

function buildAnnotation(original, analysis) {
  const block = [
    ANNOTATION_START,
    "AI 摘要：", analysis.summary,
    "", "场景：", analysis.scenes.join("、") || "无",
    "", "动作：", analysis.actions.join("、") || "无",
    "", "镜头：", analysis.shots.join("、") || "无",
    "", "风格：", analysis.styles.join("、") || "无",
    ANNOTATION_END,
  ].join("\n");
  // Match whole marker lines only; an incomplete block is preserved as user text.
  const pattern = /^\[AI Video Tagger:start\]\r?\n(?:(?!^\[AI Video Tagger:start\]\r?$)[\s\S])*?^\[AI Video Tagger:end\](?=\r?$)/m;
  const text = original || "";
  if (pattern.test(text)) return text.replace(pattern, () => block);
  return text ? text + "\n\n" + block : block;
}

const api = {
  MAX_FRAMES, AI_TIMEOUT_MS, SELECTION_TIMEOUT_MS, ANNOTATION_START, ANNOTATION_END,
  appError, friendlyError,
  createAbortError, throwIfAborted, runAbortable, execFilePromise,
  chooseFrameTimes, extractFrames, mergeTags, extractJsonFromText,
  validateAnalysis, buildAnnotation,
};
// Eagle's require() resolves relative paths from its own API module. Loading
// this file with a script tag keeps plugin-local paths relative to index.html.
if (typeof window !== "undefined") window.AIVideoTaggerCore = api;
else module.exports = api;
})();
