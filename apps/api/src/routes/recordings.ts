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
      *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
      :root{
        --bg:#f6f4ef;
        --dot:#1d1d1b;
        --capsule-bg:rgba(255,255,255,0.72);
        --capsule-border:rgba(29,29,27,0.08);
        --track-bg:rgba(29,29,27,0.1);
        --fill:#1d1d1b;
        --text:#1d1d1b;
        --text-muted:rgba(29,29,27,0.5);
        font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      }
      html,body{height:100%;overflow:hidden;background:var(--bg)}

      /* ── Falling pattern ── */
      .pattern{
        position:fixed;inset:0;z-index:0;
        background-image:
          radial-gradient(4px 100px at 0px 235px,var(--dot),transparent),
          radial-gradient(4px 100px at 300px 235px,var(--dot),transparent),
          radial-gradient(1.5px 1.5px at 150px 117.5px,var(--dot) 100%,transparent 150%),
          radial-gradient(4px 100px at 0px 252px,var(--dot),transparent),
          radial-gradient(4px 100px at 300px 252px,var(--dot),transparent),
          radial-gradient(1.5px 1.5px at 150px 126px,var(--dot) 100%,transparent 150%),
          radial-gradient(4px 100px at 0px 150px,var(--dot),transparent),
          radial-gradient(4px 100px at 300px 150px,var(--dot),transparent),
          radial-gradient(1.5px 1.5px at 150px 75px,var(--dot) 100%,transparent 150%),
          radial-gradient(4px 100px at 0px 253px,var(--dot),transparent),
          radial-gradient(4px 100px at 300px 253px,var(--dot),transparent),
          radial-gradient(1.5px 1.5px at 150px 126.5px,var(--dot) 100%,transparent 150%),
          radial-gradient(4px 100px at 0px 204px,var(--dot),transparent),
          radial-gradient(4px 100px at 300px 204px,var(--dot),transparent),
          radial-gradient(1.5px 1.5px at 150px 102px,var(--dot) 100%,transparent 150%),
          radial-gradient(4px 100px at 0px 179px,var(--dot),transparent),
          radial-gradient(4px 100px at 300px 179px,var(--dot),transparent),
          radial-gradient(1.5px 1.5px at 150px 89.5px,var(--dot) 100%,transparent 150%);
        background-size:
          300px 235px,300px 235px,300px 235px,
          300px 252px,300px 252px,300px 252px,
          300px 150px,300px 150px,300px 150px,
          300px 253px,300px 253px,300px 253px,
          300px 204px,300px 204px,300px 204px,
          300px 179px,300px 179px,300px 179px;
        animation:fall 120s linear infinite;
      }
      @keyframes fall{
        from{background-position:
          0px 220px,3px 220px,151.5px 337.5px,
          25px 24px,28px 24px,176.5px 150px,
          50px 16px,53px 16px,201.5px 91px,
          75px 224px,78px 224px,226.5px 230.5px,
          100px 19px,103px 19px,251.5px 121px,
          150px 31px,153px 31px,301.5px 120.5px}
        to{background-position:
          0px 6800px,3px 6800px,151.5px 6917.5px,
          25px 13632px,28px 13632px,176.5px 13758px,
          50px 5416px,53px 5416px,201.5px 5491px,
          75px 17175px,78px 17175px,226.5px 17301.5px,
          100px 5119px,103px 5119px,251.5px 5221px,
          150px 9876px,153px 9876px,301.5px 9965.5px}
      }

      /* ── Blur overlay (dot-grid mask) ── */
      .blur-overlay{
        position:fixed;inset:0;z-index:1;
        backdrop-filter:blur(1em);
        -webkit-backdrop-filter:blur(1em);
        background-image:radial-gradient(circle at 50% 50%,transparent 0,transparent 2px,var(--bg) 2px);
        background-size:8px 8px;
      }

      /* ── Player ── */
      .player-wrap{
        position:fixed;inset:0;z-index:2;
        display:grid;place-items:center;
      }
      .capsule{
        display:flex;align-items:center;gap:14px;
        padding:10px 20px 10px 14px;
        border-radius:999px;
        background:var(--capsule-bg);
        border:1px solid var(--capsule-border);
        backdrop-filter:blur(24px);
        -webkit-backdrop-filter:blur(24px);
        box-shadow:0 1px 3px rgba(0,0,0,0.04),0 8px 32px rgba(0,0,0,0.06);
        min-width:min(420px,calc(100vw - 48px));
        user-select:none;
      }

      /* Play / Pause */
      .play-btn{
        width:36px;height:36px;flex-shrink:0;
        border:none;border-radius:50%;cursor:pointer;
        background:var(--fill);color:var(--bg);
        display:grid;place-items:center;
        transition:transform 0.15s ease,opacity 0.15s ease;
      }
      .play-btn:hover{transform:scale(1.08)}
      .play-btn:active{transform:scale(0.96)}
      .play-btn svg{width:14px;height:14px;fill:currentColor}

      /* Time */
      .time{
        font-size:13px;font-weight:500;
        color:var(--text);
        min-width:36px;text-align:center;
        font-variant-numeric:tabular-nums;
        letter-spacing:-0.01em;
      }

      /* Track */
      .track-wrap{
        flex:1;height:36px;
        display:flex;align-items:center;
        cursor:pointer;position:relative;
      }
      .track{
        width:100%;height:4px;
        border-radius:2px;
        background:var(--track-bg);
        position:relative;overflow:hidden;
      }
      .track-fill{
        position:absolute;left:0;top:0;bottom:0;
        background:var(--fill);border-radius:2px;
        width:0%;transition:width 0.1s linear;
      }
      .track-wrap:hover .track{height:6px}
      .track-wrap:hover .track-fill{border-radius:3px}

      /* Volume */
      .vol-btn{
        width:28px;height:28px;flex-shrink:0;
        border:none;background:none;cursor:pointer;
        color:var(--text-muted);display:grid;place-items:center;
        transition:color 0.15s ease;
      }
      .vol-btn:hover{color:var(--text)}
      .vol-btn svg{width:16px;height:16px;fill:currentColor}

      @media(max-width:440px){
        .capsule{min-width:0;width:calc(100vw - 32px);gap:10px;padding:8px 14px 8px 10px}
        .time{font-size:12px;min-width:30px}
      }
      @media(prefers-reduced-motion:reduce){
        .pattern{animation:none}
      }
    </style>
  </head>
  <body>
    <div class="pattern"></div>
    <div class="blur-overlay"></div>
    <div class="player-wrap">
      <div class="capsule">
        <button class="play-btn" id="playBtn" aria-label="Play">
          <svg viewBox="0 0 16 16" id="playIcon"><polygon points="4,2 14,8 4,14"/></svg>
          <svg viewBox="0 0 16 16" id="pauseIcon" style="display:none"><rect x="3" y="2" width="3.5" height="12" rx="1"/><rect x="9.5" y="2" width="3.5" height="12" rx="1"/></svg>
        </button>
        <span class="time" id="curTime">0:00</span>
        <div class="track-wrap" id="trackWrap">
          <div class="track">
            <div class="track-fill" id="trackFill"></div>
          </div>
        </div>
        <span class="time" id="durTime">-:--</span>
        <button class="vol-btn" id="volBtn" aria-label="Mute">
          <svg viewBox="0 0 24 24" id="volOn"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 8.5v7a4.47 4.47 0 002.5-3.5zM14 3.23v2.06a6.51 6.51 0 010 13.42v2.06A8.5 8.5 0 0014 3.23z"/></svg>
          <svg viewBox="0 0 24 24" id="volOff" style="display:none"><path d="M16.5 12A4.5 4.5 0 0014 8.5v2.09l2.43 2.43c.03-.17.07-.34.07-.52zM19 12a6.51 6.51 0 00-.78-3.12l-1.46 1.46A4.47 4.47 0 0117 12c0 1.66-.89 3.1-2.22 3.88l1.46 1.46A6.53 6.53 0 0019 12zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.51-1.42.93-2.25 1.18v2.06a8.46 8.46 0 003.69-2.02L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
        </button>
      </div>
    </div>
    <audio id="audio" preload="metadata" src="${audioPath}"></audio>
    <script>
    (function(){
      var a=document.getElementById('audio'),
          playBtn=document.getElementById('playBtn'),
          playIcon=document.getElementById('playIcon'),
          pauseIcon=document.getElementById('pauseIcon'),
          curTime=document.getElementById('curTime'),
          durTime=document.getElementById('durTime'),
          trackFill=document.getElementById('trackFill'),
          trackWrap=document.getElementById('trackWrap'),
          volBtn=document.getElementById('volBtn'),
          volOn=document.getElementById('volOn'),
          volOff=document.getElementById('volOff'),
          seeking=false;

      function fmt(s){
        if(!isFinite(s))return'-:--';
        var m=Math.floor(s/60),sec=Math.floor(s%60);
        return m+':'+(sec<10?'0':'')+sec;
      }

      playBtn.onclick=function(){
        if(a.paused){a.play()}else{a.pause()}
      };

      a.onplay=function(){playIcon.style.display='none';pauseIcon.style.display='block'};
      a.onpause=function(){playIcon.style.display='block';pauseIcon.style.display='none'};

      a.onloadedmetadata=function(){durTime.textContent=fmt(a.duration)};
      a.ondurationchange=function(){durTime.textContent=fmt(a.duration)};

      a.ontimeupdate=function(){
        if(seeking)return;
        curTime.textContent=fmt(a.currentTime);
        if(a.duration>0){
          trackFill.style.width=(a.currentTime/a.duration*100)+'%';
        }
      };

      a.onended=function(){
        playIcon.style.display='block';pauseIcon.style.display='none';
        trackFill.style.width='100%';
      };

      trackWrap.onpointerdown=function(e){
        seeking=true;
        seek(e);
        trackWrap.setPointerCapture(e.pointerId);
      };
      trackWrap.onpointermove=function(e){if(seeking)seek(e)};
      trackWrap.onpointerup=function(){seeking=false};

      function seek(e){
        var r=trackWrap.getBoundingClientRect();
        var p=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));
        if(a.duration>0){
          a.currentTime=p*a.duration;
          trackFill.style.width=(p*100)+'%';
          curTime.textContent=fmt(a.currentTime);
        }
      }

      volBtn.onclick=function(){
        a.muted=!a.muted;
        volOn.style.display=a.muted?'none':'block';
        volOff.style.display=a.muted?'block':'none';
      };
    })();
    </script>
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
    const contentLength = upstream.headers.get("content-length");

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=3600",
      "Accept-Ranges": "bytes",
    };
    if (contentLength) {
      headers["Content-Length"] = contentLength;
    }

    for (const [k, v] of Object.entries(headers)) {
      reply.header(k, v);
    }
    return reply.send(upstream.body);
  });
}
