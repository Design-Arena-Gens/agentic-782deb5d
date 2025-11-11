"use client";

import React, { useCallback, useMemo, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

type MediaItem = {
  id: string;
  file: File;
  caption: string;
  durationSec: number;
};

const CORE_VERSION = "0.12.6"; // stable core

export default function VideoMaker() {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState<string>("");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [resolution, setResolution] = useState<{ w: number; h: number }>({ w: 1280, h: 720 });
  const [fps, setFps] = useState<number>(30);
  const [fontUrl, setFontUrl] = useState<string>("https://fonts.gstatic.com/s/roboto/v30/KFOmCnqEu92Fr1Mu4mxP.ttf");

  const ffmpegRef = useRef<FFmpeg | null>(null);

  const ensureFFmpeg = useCallback(async () => {
    if (ffmpegRef.current) return ffmpegRef.current;
    const ffmpeg = new FFmpeg();
    ffmpeg.on("log", ({ message }) => {
      // optional: console.log(message);
    });
    ffmpeg.on("progress", ({ progress }) => setProgress(Math.round(progress * 100)));

    const base = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist`;
    await ffmpeg.load({
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
      workerURL: await toBlobURL(`${base}/ffmpeg-core.worker.js`, "text/javascript"),
    });
    ffmpegRef.current = ffmpeg;
    return ffmpeg;
  }, []);

  const onPickMedia = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const newItems: MediaItem[] = files.map((f) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file: f,
      caption: "",
      durationSec: 3,
    }));
    setItems((prev) => [...prev, ...newItems]);
    e.currentTarget.value = "";
  }, []);

  const onPickAudio = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] || null;
    setAudioFile(f);
  }, []);

  const updateItem = useCallback((id: string, patch: Partial<MediaItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const canCreate = useMemo(() => items.length > 0 && !isBusy, [items.length, isBusy]);

  const createVideo = useCallback(async () => {
    setIsBusy(true);
    setMessage("");
    setProgress(0);
    setVideoUrl(null);

    try {
      const ffmpeg = await ensureFFmpeg();

      // Reset FS for clean run
      try {
        // Remove old artifacts if any
        const files = await ffmpeg.listDir("/");
        for (const f of files) {
          if (f.name && f.name !== "." && f.name !== "..") {
            try { await ffmpeg.deleteFile(`/${f.name}`); } catch {}
          }
        }
      } catch {}

      // Write font file if we can fetch it
      let fontPath = "font.ttf";
      try {
        const fontBin = await fetchFile(fontUrl);
        await ffmpeg.writeFile(fontPath, fontBin);
      } catch {
        // No font available ? we'll render without drawtext if it fails
        fontPath = "";
      }

      // Write media and generate per-image video parts
      const partNames: string[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const inputName = `input_${i}${extOf(it.file.name)}`;
        const partName = `part_${i}.mp4`;
        await ffmpeg.writeFile(inputName, await fetchFile(it.file));

        const scalePad = `scale=${resolution.w}:-2:force_original_aspect_ratio=decrease,pad=${resolution.w}:${resolution.h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
        const hasCaption = it.caption.trim().length > 0 && fontPath;
        const vf = hasCaption
          ? `${scalePad},drawtext=fontfile=${fontPath}:text='${escapeDrawtext(it.caption)}':fontcolor=white:fontsize=${Math.round(
              Math.min(resolution.w, resolution.h) / 18
            )}:x=(w-text_w)/2:y=h-(${Math.round(resolution.h / 8)}):shadowcolor=0x000000@0.5:shadowx=2:shadowy=2`
          : scalePad;

        const args = [
          "-loop", "1",
          "-t", String(Math.max(0.2, it.durationSec)),
          "-i", inputName,
          "-r", String(fps),
          "-vf", vf,
          "-an",
          "-c:v", "libx264",
          "-pix_fmt", "yuv420p",
          "-movflags", "+faststart",
          partName,
        ];

        await ffmpeg.exec(["-y", ...args]);
        partNames.push(partName);
      }

      // Create concat list
      const listTxt = partNames.map((p) => `file '${p}'`).join("\n");
      await ffmpeg.writeFile("concat_list.txt", new TextEncoder().encode(listTxt));

      // Concatenate parts into a single mp4
      await ffmpeg.exec(["-y", "-f", "concat", "-safe", "0", "-i", "concat_list.txt", "-c", "copy", "output_video.mp4"]);

      // If audio present, mux it in
      let finalName = "final.mp4";
      if (audioFile) {
        await ffmpeg.writeFile("audio_in", await fetchFile(audioFile));
        // Try to transcode with AAC audio
        try {
          await ffmpeg.exec([
            "-y",
            "-i", "output_video.mp4",
            "-i", "audio_in",
            "-shortest",
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "192k",
            finalName,
          ]);
        } catch (e) {
          // Fallback: keep video only if AAC not available
          finalName = "output_video.mp4";
        }
      } else {
        finalName = "output_video.mp4";
      }

      const data = await ffmpeg.readFile(finalName);
      const blob = new Blob([data as Uint8Array], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);
      setVideoUrl(url);
      setMessage("??????! ???????? ???? ????? ????.");
    } catch (e: any) {
      setMessage("?????? ??? ???????? ?????. ?????????? ????????? ?????? ??? ????????????? ????????.");
    } finally {
      setIsBusy(false);
      setProgress(0);
    }
  }, [items, audioFile, ensureFFmpeg, fps, fontUrl, resolution.h, resolution.w]);

  return (
    <div className="container">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>????????? ?????</h1>
        <span className="badge">?????????? FFmpeg</span>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 12 }}>
          <label className="label">???????? ??????????? (????? ?????????):</label>
          <input className="input" type="file" accept="image/*" multiple onChange={onPickMedia} />
        </div>
        <div className="row" style={{ marginBottom: 12 }}>
          <label className="label">?????????????? ???????????? (??????):</label>
          <input className="input" type="file" accept="audio/*" onChange={onPickAudio} />
          {audioFile && <span className="small">{audioFile.name}</span>}
        </div>
        <div className="row" style={{ marginBottom: 12 }}>
          <label className="label">??????????:</label>
          <select className="input" value={`${resolution.w}x${resolution.h}`} onChange={(e) => {
            const [w, h] = e.target.value.split("x").map(Number);
            setResolution({ w, h });
          }}>
            <option value="1280x720">1280x720 (HD)</option>
            <option value="1920x1080">1920x1080 (Full HD)</option>
            <option value="1080x1080">1080x1080 (???????)</option>
            <option value="1080x1920">1080x1920 (???????????)</option>
          </select>
          <label className="label">FPS:</label>
          <select className="input" value={fps} onChange={(e) => setFps(Number(e.target.value))}>
            <option value={24}>24</option>
            <option value={25}>25</option>
            <option value={30}>30</option>
            <option value={60}>60</option>
          </select>
          <label className="label">????? ??? ?????? (URL):</label>
          <input className="input" style={{ minWidth: 260 }} value={fontUrl} onChange={(e) => setFontUrl(e.target.value)} />
        </div>
      </div>

      {items.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>??????</h3>
          <ul className="list" style={{ display: "grid", gap: 12 }}>
            {items.map((it, idx) => (
              <li key={it.id} style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <span className="badge">{idx + 1}</span>
                <span style={{ flex: 1, minWidth: 160 }} className="small">{it.file.name}</span>
                <input
                  className="input"
                  style={{ flex: 2, minWidth: 200 }}
                  placeholder="????? ??????? (?????????????)"
                  value={it.caption}
                  onChange={(e) => updateItem(it.id, { caption: e.target.value })}
                />
                <label className="label">????????????, ???:</label>
                <input
                  className="input"
                  type="number"
                  min={0.2}
                  step={0.1}
                  value={it.durationSec}
                  onChange={(e) => updateItem(it.id, { durationSec: clamp(Number(e.target.value), 0.2, 120) })}
                  style={{ width: 96 }}
                />
                <button className="btn secondary" onClick={() => removeItem(it.id)}>???????</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card" style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button className="btn" disabled={!canCreate} onClick={createVideo}>
          {isBusy ? "???????..." : "??????? ?????"}
        </button>
        {isBusy && (
          <div style={{ flex: 1 }}>
            <div className="progress"><div style={{ width: `${progress}%` }} /></div>
            <div className="small" style={{ marginTop: 6 }}>{progress}%</div>
          </div>
        )}
        {message && <div className="small">{message}</div>}
      </div>

      {videoUrl && (
        <div className="card" style={{ marginTop: 16 }}>
          <video src={videoUrl} controls style={{ width: "100%", borderRadius: 12 }} />
          <div className="row" style={{ marginTop: 12 }}>
            <a className="btn" href={videoUrl} download="video.mp4">??????? ?????</a>
          </div>
        </div>
      )}

      <p className="small" style={{ marginTop: 16 }}>
        ?????: ??? ?????????? ?????? ??????????? ?? ??????? ??????? ??????????? ? ???????? ????????????.
      </p>
    </div>
  );
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function extOf(name: string) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i) : "";
}

function escapeDrawtext(text: string) {
  // Escape characters problematic for drawtext
  return text
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\\/g, "\\\\");
}
