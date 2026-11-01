#!/usr/bin/env node
// F60 acceptance: attach arbitrary files to an studio job.
//
// Runs on laptop against the installed Fleet on both Macs. It:
//   1. generates a deterministic PDF of about 5.2 MB with exactly 41 pages
//      (padded with an incompressible embedded image) and hashes it;
//   2. copies a real sample logo.png to scratch (F59's logo.png check);
//   3. uploads both as laptop project attachments and starts one studio Codex task
//      through fleet work_start (attachments travel over the direct SSH owner
//      route, never the broker), asking studio for the page count and SHA-256s;
//   4. kills the laptop watcher (the client call) mid-start, reconnects with the
//      same request id and proves the same request is recovered with exactly
//      one owner thread created on studio;
//   5. reads the owner receipt on studio and the studio agent's reply.
// Proof is written to /tmp/f60-files/proof.json. Exit 0 only if every check passes.
//
// Nothing here restarts services, edits ~/.bb or touches the live install.

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PAGE_COUNT = 41;
export const IMAGE_WIDTH = 2000;
export const IMAGE_HEIGHT = 2600; // 5,200,000 image bytes
const studio_BB = "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb";
const studio_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const OUT = process.env.F60_OUT ?? "/tmp/f60-files";
const ROUTE = process.argv.includes("--direct-owner") || process.env.F60_ROUTE === "direct-owner" ? "direct-owner" : "fleet";
const LOGO_SOURCE = process.env.F60_LOGO;
if (!LOGO_SOURCE && process.argv[1]?.endsWith("f60-files.mjs")) throw new Error("Set F60_LOGO to the path of a PNG file to attach");

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Deterministic, incompressible bytes: SHA-256 in counter mode over a fixed seed. */
export function deterministicBytes(length, seed = "fleet-f60-pdf-padding-v1") {
  const out = Buffer.alloc(length);
  let offset = 0;
  for (let counter = 0; offset < length; counter++) {
    const block = createHash("sha256").update(`${seed}:${counter}`).digest();
    offset += block.copy(out, offset, 0, Math.min(block.length, length - offset));
  }
  return out;
}

/** A valid PDF 1.4 with exactly `pages` pages and one raw 8-bit greyscale image on page 1. */
export function buildPdf({ pages = PAGE_COUNT, width = IMAGE_WIDTH, height = IMAGE_HEIGHT } = {}) {
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (data) => { const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1"); chunks.push(buf); length += buf.length; };
  const object = (id, body) => { offsets[id] = length; push(`${id} 0 obj\n`); for (const part of [].concat(body)) push(part); push("\nendobj\n"); };

  // 1 catalog, 2 pages, 3 font, 4 image, then (page, content) pairs.
  const pageIds = Array.from({ length: pages }, (_, i) => 5 + i * 2);
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`);
  object(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const image = deterministicBytes(width * height);
  object(4, [`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${image.length} >>\nstream\n`, image, "\nendstream"]);
  for (let i = 0; i < pages; i++) {
    const pageId = pageIds[i];
    const text = `BT /F1 24 Tf 72 720 Td (Fleet F60 acceptance page ${i + 1}) Tj ET`;
    const content = i === 0 ? `q 468 0 0 608.4 72 72 cm /Im1 Do Q\n${text}` : text;
    const resources = i === 0 ? "<< /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >>" : "<< /Font << /F1 3 0 R >> >>";
    object(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents ${pageId + 1} 0 R >>`);
    object(pageId + 1, `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
  }
  const size = 5 + pages * 2;
  const xref = length;
  push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let id = 1; id < size; id++) push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const pdf = Buffer.concat(chunks);
  if (countPdfPages(pdf) !== pages) throw new Error("Generated PDF page markers do not match the requested page count");
  return pdf;
}

/** Page objects in a PDF built here (no compressed object streams). */
export function countPdfPages(pdf) {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
}

/** pages=, pdf_sha256= and logo_sha256= from the studio agent's reply. */
export function parseReply(text) {
  const pages = /pages\s*=\s*(\d+)/i.exec(text)?.[1];
  const pdf = /pdf_sha256\s*=\s*([a-f0-9]{64})/i.exec(text)?.[1];
  const logo = /logo_sha256\s*=\s*([a-f0-9]{64})/i.exec(text)?.[1];
  return { pages: pages === undefined ? null : Number(pages), pdfSha256: pdf?.toLowerCase() ?? null, logoSha256: logo?.toLowerCase() ?? null };
}

// ---------- process helpers ----------

function run(bin, args, { input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input ?? "");
  });
}

function json(text, what) {
  try { return JSON.parse(text); } catch { throw new Error(`${what} did not answer with JSON: ${text.slice(0, 400)}`); }
}

/** Unwrap `bb ... --json` envelopes. */
function unwrap(body, what) {
  if (body && typeof body === "object" && body.ok === false) throw new Error(`${what} failed: ${JSON.stringify(body.error ?? body).slice(0, 600)}`);
  return body && typeof body === "object" && body.ok === true && "result" in body ? body.result : body;
}

async function laptopRpc(method, input, timeoutMs = 120_000) {
  const file = `${OUT}/rpc-${method}-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(input));
  const r = await run("bb", ["plugin", "rpc", "call", "fleet", method, "--input-file", file, "--json"], { timeoutMs });
  return unwrap(json(r.stdout, `laptop fleet.${method}`), `laptop fleet.${method}`);
}

async function studio(command, input, timeoutMs = 60_000) {
  const r = await run("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15", "studio", `PATH='${studio_PATH}' ${command}`], { input, timeoutMs });
  if (r.code !== 0 && r.stdout.trim() === "") throw new Error(`studio command failed (${r.code}): ${r.stderr.trim().split("\n")[0]}`);
  return r.stdout;
}

async function studioRpc(method, input) {
  const out = await studio(`'${studio_BB}' plugin rpc call fleet '${method}' --input-file /dev/stdin --json`, JSON.stringify(input));
  return unwrap(json(out, `studio fleet.${method}`), `studio fleet.${method}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- the two routes ----------

/**
 * Default route: laptop's installed Fleet. Upload both files as laptop project
 * attachments (what the composer does), call fleet work_start on laptop, kill
 * that watcher mid-start, then reconnect by reading laptop's receipt and
 * replaying the same request id, which must return the recorded start.
 */
async function startThroughFleet({ requestId, title, prompt, providerId, files, killAfterMs, proof, note }) {
  const projectId = process.env.F60_SOURCE_PROJECT ?? process.env.BB_PROJECT_ID;
  if (!projectId) throw new Error("Set F60_SOURCE_PROJECT (or run inside a bb project) to the project that holds the attachments");
  const upload = async ({ path, name, mimeType }) => {
    const r = await run("bb", ["project", "attachment", "upload", projectId, "--client-file", path, "--filename", name, "--mime-type", mimeType, "--json"]);
    const dto = unwrap(json(r.stdout, "bb project attachment upload"), "bb project attachment upload");
    const back = `${OUT}/download-${name}`;
    const d = await run("bb", ["project", "attachment", "download", projectId, dto.path, "--client-file", back]);
    let stored = null;
    try { stored = sha256(readFileSync(back)); } catch { stored = null; }
    return { dto, downloadCode: d.code, storedSha256: stored };
  };
  const pdfUp = await upload(files.pdf);
  const logoUp = await upload(files.logo);
  proof.laptopAttachments = { projectId, pdf: pdfUp, logo: logoUp };
  note(`laptop attachments ${pdfUp.dto.path} (${pdfUp.dto.sizeBytes} B) and ${logoUp.dto.path} (${logoUp.dto.sizeBytes} B) in ${projectId}`);
  const input = {
    machine: "studio", prompt, title, requestId, providerId,
    attachments: [
      { type: "localFile", sourceProjectId: projectId, path: pdfUp.dto.path, name: files.pdf.name, mimeType: files.pdf.mimeType },
      { type: "localImage", sourceProjectId: projectId, path: logoUp.dto.path, name: files.logo.name, mimeType: files.logo.mimeType },
    ],
  };
  const inputFile = `${OUT}/work-start-${requestId}.json`;
  writeFileSync(inputFile, JSON.stringify(input));
  const first = spawn("bb", ["plugin", "rpc", "call", "fleet", "work_start", "--input-file", inputFile, "--json"], { stdio: ["ignore", "pipe", "pipe"] });
  const watcher = await killMidway(first, killAfterMs);
  const atKill = await laptopRpc("work_receipt", { requestId });
  const studioAtKill = await studioRpc("work_receipt", { requestId }).catch((cause) => ({ error: String(cause.message ?? cause) }));
  proof.reconnect = { watcher: "laptop fleet work_start client", ...watcher, laptopReceiptAtKill: atKill, studioReceiptAtKill: studioAtKill };
  note(`watcher 1 ${watcher.killedMidStart ? "killed" : "finished"} after ${killAfterMs} ms; laptop receipt ${atKill.state}; studio receipt ${studioAtKill.state ?? studioAtKill.error}`);
  const recovered = await waitForReceipt(() => laptopRpc("work_receipt", { requestId }), atKill, "laptop");
  const replay = await laptopRpc("work_start", input, 180_000);
  proof.reconnect.recovered = recovered;
  proof.reconnect.replay = replay;
  note(`reconnected: laptop receipt completed for ${recovered.result.requestId} thread ${recovered.result.threadId}; replay returned thread ${replay.threadId}`);
  const bytesSentMatch = pdfUp.storedSha256 === sha256(files.pdf.bytes) && logoUp.storedSha256 === sha256(files.logo.bytes);
  return { killedMidStart: watcher.killedMidStart, atKill, recovered, replay, bytesSentMatch };
}

/**
 * Direct-owner route: exactly the two owner calls laptop's Fleet makes for an studio
 * attachment job (work_attachments_put, then work_start with the owner-side
 * references), made with this branch's owner transport over the existing studio
 * SSH alias. Proves the transport fix against studio's real Fleet before laptop's
 * installed Fleet is redeployed. The work_start watcher is killed mid-start,
 * then reconnected through studio's receipt and a same-id replay.
 */
async function startDirectOwner({ requestId, title, prompt, providerId, files, killAfterMs, proof, note }) {
  const { createSshOwnerTransport, ownerRpcCommand } = await import(new URL("../owner/transport.ts", import.meta.url).href);
  const owner = createSshOwnerTransport({ alias: "studio", timeoutMs: 180_000 });
  const call = async (method, input, mutation) => {
    const outcome = await owner.call("fleet", method, input, mutation);
    if (!outcome.ok) throw new Error(`studio fleet.${method} ${outcome.kind}: ${outcome.message}`);
    return outcome.result;
  };
  const payload = [
    { type: "localFile", name: files.pdf.name, mimeType: files.pdf.mimeType, contentBase64: files.pdf.bytes.toString("base64"), sha256: sha256(files.pdf.bytes) },
    { type: "localImage", name: files.logo.name, mimeType: files.logo.mimeType, contentBase64: files.logo.bytes.toString("base64"), sha256: sha256(files.logo.bytes) },
  ];
  const bytesSentMatch = payload.every((file, index) => sha256(Buffer.from(file.contentBase64, "base64")) === sha256([files.pdf.bytes, files.logo.bytes][index]));
  const putStarted = Date.now();
  const put = await call("work_attachments_put", { v: 1, requestId: randomUUID(), files: payload }, true);
  proof.ownerAttachmentsPut = { ...put, ms: Date.now() - putStarted, inputBytes: Buffer.byteLength(JSON.stringify(payload)) };
  note(`studio work_attachments_put stored ${put.attachments.map((a) => `${a.name} ${a.sizeBytes} B ${a.sha256}`).join("; ")} in ${put.projectId} (${proof.ownerAttachmentsPut.ms} ms)`);
  const input = { machine: "studio", prompt, title, requestId, providerId, routing: {}, projectId: put.projectId, ownerAttachments: put.attachments };
  const first = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "studio", ownerRpcCommand("fleet", "work_start")], { stdio: ["pipe", "pipe", "pipe"] });
  first.stdin.on("error", () => undefined);
  first.stdin.end(JSON.stringify(input));
  const watcher = await killMidway(first, killAfterMs);
  const atKill = await studioRpc("work_receipt", { requestId });
  proof.reconnect = { watcher: "direct owner work_start over SSH", ...watcher, studioReceiptAtKill: atKill };
  note(`watcher 1 ${watcher.killedMidStart ? "killed" : "finished"} after ${killAfterMs} ms; studio receipt ${atKill.state}`);
  const recovered = await waitForReceipt(() => studioRpc("work_receipt", { requestId }), atKill, "studio");
  const replay = await call("work_start", input, true);
  proof.reconnect.recovered = recovered;
  proof.reconnect.replay = replay;
  note(`reconnected: studio receipt completed for ${recovered.result.requestId} thread ${recovered.result.threadId}; replay returned thread ${replay.threadId}`);
  return { killedMidStart: watcher.killedMidStart, atKill, recovered, replay, bytesSentMatch };
}

async function killMidway(child, killAfterMs) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b) => { stdout += b; });
  child.stderr.on("data", (b) => { stderr += b; });
  const exit = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const raced = await Promise.race([exit.then(() => true), sleep(killAfterMs).then(() => false)]);
  if (!raced) child.kill("SIGTERM");
  const result = await exit;
  return { killedMidStart: !raced, firstWatcher: { ...result, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000) } };
}

/** Reconnect: poll the receipt for the same request id; never start again. */
async function waitForReceipt(read, first, where) {
  let receipt = first;
  const deadline = Date.now() + 240_000;
  while (receipt.state !== "completed" && Date.now() < deadline) {
    if (receipt.notStarted) throw new Error(`${where} says nothing was started: ${JSON.stringify(receipt.notStarted)}`);
    await sleep(2000);
    receipt = await read();
  }
  if (receipt.state !== "completed") throw new Error(`${where} receipt is still ${receipt.state}; the outcome is unknown and must not be resent`);
  return receipt;
}

// ---------- acceptance ----------

async function main() {
  mkdirSync(OUT, { recursive: true });
  const startedAt = Date.now();
  const log = [];
  const note = (line) => { const entry = `${new Date().toISOString()} ${line}`; log.push(entry); console.log(entry); };
  const proof = { item: "F60", startedAt: new Date(startedAt).toISOString(), checks: {}, log };
  const finish = (code) => {
    proof.finishedAt = new Date().toISOString();
    proof.pass = code === 0;
    writeFileSync(`${OUT}/proof.json`, `${JSON.stringify(proof, null, 2)}\n`);
    console.log(`proof: ${OUT}/proof.json pass=${proof.pass}`);
    process.exit(code);
  };

  try {
    // 1. Source files on laptop.
    const pdf = buildPdf();
    const pdfPath = `${OUT}/f60-acceptance-41-pages.pdf`;
    writeFileSync(pdfPath, pdf);
    const logoPath = `${OUT}/logo.png`;
    copyFileSync(LOGO_SOURCE, logoPath);
    const logo = readFileSync(logoPath);
    if (!logo.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error(`${LOGO_SOURCE} is not a PNG`);
    proof.source = {
      pdf: { path: pdfPath, sizeBytes: pdf.length, sha256: sha256(pdf), pages: PAGE_COUNT, pageObjects: countPdfPages(pdf) },
      logo: { path: logoPath, copiedFrom: LOGO_SOURCE, sizeBytes: logo.length, sha256: sha256(logo) },
    };
    note(`source pdf ${pdf.length} bytes sha256 ${proof.source.pdf.sha256}; logo ${logo.length} bytes sha256 ${proof.source.logo.sha256}`);

    // 2. The request: one studio Codex start with both attachments.
    const requestId = `f60-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const title = `F60 files ${requestId}`;
    const prompt = [
      "F60 acceptance check from the laptop. Two files are attached to this message: a PDF and logo.png.",
      "On this Mac, find the attached files on disk and compute, without modifying, moving or uploading them:",
      "1. the number of pages in the PDF, using a real PDF reader (for example macOS PDFKit through swift, pdfinfo, or a Python PDF library);",
      "2. the SHA-256 of the exact bytes of each attached file (shasum -a 256).",
      "Reply with exactly these three lines and nothing else:",
      "pages=<integer>",
      "pdf_sha256=<64 lowercase hex characters>",
      "logo_sha256=<64 lowercase hex characters>",
    ].join("\n");
    const providerId = process.env.F60_PROVIDER ?? "codex";
    const killAfterMs = Number(process.env.F60_KILL_AFTER_MS ?? (ROUTE === "direct-owner" ? 1500 : 2000));
    proof.request = { route: ROUTE, requestId, title, providerId, machine: "studio", killAfterMs };
    note(`route ${ROUTE}: request ${requestId}`);
    const files = { pdf: { name: "f60-acceptance-41-pages.pdf", mimeType: "application/pdf", path: pdfPath, bytes: pdf }, logo: { name: "logo.png", mimeType: "image/png", path: logoPath, bytes: logo } };
    const started = ROUTE === "direct-owner"
      ? await startDirectOwner({ requestId, title, prompt, providerId, files, killAfterMs, proof, note })
      : await startThroughFleet({ requestId, title, prompt, providerId, files, killAfterMs, proof, note });
    const { killedMidStart, atKill, recovered, replay, bytesSentMatch } = started;

    // 6. Owner receipt on studio.
    const ownerReceipt = await studioRpc("work_receipt", { requestId });
    proof.ownerReceipt = ownerReceipt;
    const threadId = ownerReceipt.result?.threadId ?? null;
    note(`studio owner receipt ${ownerReceipt.state} thread ${threadId}`);

    // 7. Exactly one owner thread on studio for this request.
    const threads = json(await studio(`'${studio_BB}' thread list --json --include-hidden`), "studio thread list");
    const matching = threads.filter((t) => t.title === title || (t.title ?? "").includes(requestId) || (t.titleFallback ?? "").includes(requestId));
    proof.ownerThreads = { matching: matching.map(({ id, projectId: p, providerId, title: t, status, createdAt }) => ({ id, projectId: p, providerId, title: t, status, createdAt })) };
    note(`studio threads for ${requestId}: ${matching.map((t) => t.id).join(", ") || "none"}`);

    // 8. The studio agent's reply.
    let answer = null;
    const answerDeadline = Date.now() + Number(process.env.F60_ANSWER_TIMEOUT_MS ?? 15 * 60_000);
    while (threadId && Date.now() < answerDeadline) {
      answer = await studioRpc("thread_answer_get", { threadId }).catch((cause) => ({ error: String(cause.message ?? cause) }));
      if (answer.state === "idle" && answer.output?.trim()) break;
      if (answer.state === "error" || answer.state === "needs-you") break;
      await sleep(10_000);
    }
    const parsed = parseReply(answer?.output ?? "");
    proof.reply = { threadId, state: answer?.state ?? null, url: answer?.url ?? null, output: answer?.output ?? answer?.error ?? null, parsed };
    note(`studio reply state ${answer?.state}: ${JSON.stringify(parsed)}`);

    // Checks.
    const src = proof.source;
    const att = ownerReceipt.result?.attachments ?? [];
    const pdfAtt = att.find((a) => a.sha256 === src.pdf.sha256);
    const logoAtt = att.find((a) => a.sha256 === src.logo.sha256);
    proof.checks = {
      "1_pdfAtLeast5MB": src.pdf.sizeBytes >= 5_000_000,
      "1_ownerReceiptCompleted": ownerReceipt.state === "completed",
      "1_ownerPdfSha256MatchesVerified": Boolean(pdfAtt && pdfAtt.verified === true && pdfAtt.sizeBytes === src.pdf.sizeBytes),
      "1_ownerLogoSha256MatchesVerified": Boolean(logoAtt && logoAtt.verified === true && logoAtt.sizeBytes === src.logo.sizeBytes),
      "1_sentBytesMatchSource": bytesSentMatch,
      "2_replyPages41": parsed.pages === PAGE_COUNT,
      "2_replyPdfSha256Matches": parsed.pdfSha256 === src.pdf.sha256,
      "2_replyLogoSha256Matches": parsed.logoSha256 === src.logo.sha256,
      "3_killedMidStart": killedMidStart && atKill.state !== "completed",
      "3_sameRequestRecovered": recovered.result?.requestId === requestId && replay.requestId === requestId && ownerReceipt.result?.requestId === requestId,
      "3_sameThreadEverywhere": Boolean(threadId) && recovered.result?.threadId === threadId && replay.threadId === threadId,
      "3_exactlyOneOwnerThread": matching.length === 1 && matching[0].id === threadId,
    };
    const failed = Object.entries(proof.checks).filter(([, ok]) => !ok).map(([name]) => name);
    note(failed.length ? `FAILED: ${failed.join(", ")}` : "all F60 checks passed");
    finish(failed.length ? 1 : 0);
  } catch (cause) {
    proof.error = String(cause?.stack ?? cause);
    note(`error: ${cause?.message ?? cause}`);
    finish(2);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
