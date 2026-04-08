import type { FastifyInstance } from "fastify";
import { createStorageClient, verifyArtifactToken } from "@vent/artifacts";

export async function recordingRoutes(app: FastifyInstance) {
  async function resolveRecordingDownloadUrl(token: string): Promise<string | null> {
    const secret = process.env["RUNNER_CALLBACK_SECRET"] ?? "";
    if (!secret) return null;

    const key = verifyArtifactToken(token, secret);
    if (!key) return null;

    let storage;
    try {
      storage = createStorageClient();
    } catch {
      return null;
    }

    try {
      return await storage.presignDownload(key, 3600);
    } catch {
      return null;
    }
  }

  app.get<{ Params: { token: string } }>("/recordings/:token", async (request, reply) => {
    const downloadUrl = await resolveRecordingDownloadUrl(request.params.token);
    if (!downloadUrl) {
      return reply.status(404).send({ error: "Recording not found" });
    }

    const audioPath = `/recordings/${encodeURIComponent(request.params.token)}/audio`;
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Vent Recording</title>
    <style>
      :root {
        color-scheme: light;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f6f4ef;
        color: #1d1d1b;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top, rgba(220, 186, 123, 0.35), transparent 40%),
          linear-gradient(180deg, #faf8f2 0%, #f1ece1 100%);
      }
      main {
        width: min(560px, calc(100vw - 32px));
        padding: 28px;
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.9);
        box-shadow: 0 24px 60px rgba(39, 30, 10, 0.12);
      }
      h1 {
        margin: 0 0 10px;
        font-size: 1.4rem;
      }
      p {
        margin: 0 0 20px;
        color: #4e4636;
        line-height: 1.5;
      }
      audio {
        width: 100%;
      }
      a {
        color: #77521f;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Vent Recording</h1>
      <p>Press play to listen to the call recording.</p>
      <audio controls preload="metadata" src="${audioPath}">
        Your browser does not support audio playback.
      </audio>
      <p><a href="${audioPath}">Open audio directly</a></p>
    </main>
  </body>
</html>`;

    return reply
      .header("Content-Type", "text/html; charset=utf-8")
      .header("Cache-Control", "private, no-store")
      .send(html);
  });

  app.get<{ Params: { token: string } }>("/recordings/:token/audio", async (request, reply) => {
    const downloadUrl = await resolveRecordingDownloadUrl(request.params.token);
    if (!downloadUrl) {
      return reply.status(404).send({ error: "Recording not found" });
    }

    // Proxy audio instead of redirecting — R2 presigned URLs may set
    // Content-Disposition: attachment which forces a download.
    const upstream = await fetch(downloadUrl);
    if (!upstream.ok || !upstream.body) {
      return reply.status(502).send({ error: "Failed to fetch recording" });
    }

    const contentType =
      upstream.headers.get("content-type") ?? "audio/wav";

    return reply
      .header("Content-Type", contentType)
      .header("Content-Disposition", "inline")
      .header("Cache-Control", "private, max-age=3600")
      .send(upstream.body);
  });
}
