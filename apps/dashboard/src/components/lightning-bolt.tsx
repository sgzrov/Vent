"use client";

import { useEffect, useRef, useCallback } from "react";

export function LightningBolt() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number>(0);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width;
    const H = canvas.height;

    // Lightning state
    interface Bolt {
      segments: { x: number; y: number }[];
      progress: number; // 0-1 how far drawn
      opacity: number;
      width: number;
      phase: "strike" | "hold" | "fade";
      holdTime: number;
      fadeTime: number;
      branches: Branch[];
      color: string;
    }

    interface Branch {
      segments: { x: number; y: number }[];
      startIndex: number;
      progress: number;
      opacity: number;
      width: number;
    }

    function generateBoltPath(
      startX: number,
      startY: number,
      endY: number,
      jag: number,
      segments: number
    ): { x: number; y: number }[] {
      const points: { x: number; y: number }[] = [{ x: startX, y: startY }];
      const stepY = (endY - startY) / segments;
      let x = startX;

      for (let i = 1; i <= segments; i++) {
        const isLast = i === segments;
        x += (Math.random() - 0.5) * jag * 2;
        // Keep within bounds
        x = Math.max(W * 0.2, Math.min(W * 0.8, x));
        points.push({
          x: isLast ? startX + (Math.random() - 0.5) * 30 : x,
          y: startY + stepY * i,
        });
      }
      return points;
    }

    function generateBranch(
      parentSegments: { x: number; y: number }[],
      startIdx: number,
      direction: number
    ): { x: number; y: number }[] {
      const start = parentSegments[startIdx];
      if (!start) return [];
      const points: { x: number; y: number }[] = [{ x: start.x, y: start.y }];
      const len = 3 + Math.floor(Math.random() * 4);
      let x = start.x;
      let y = start.y;
      for (let i = 0; i < len; i++) {
        x += direction * (15 + Math.random() * 25);
        y += 15 + Math.random() * 20;
        points.push({ x, y });
      }
      return points;
    }

    // State management
    let bolts: Bolt[] = [];
    let timer = 0;
    let nextStrikeAt = 0;
    const sparkParticles: {
      x: number;
      y: number;
      vx: number;
      vy: number;
      life: number;
      maxLife: number;
      size: number;
    }[] = [];

    function createBolt(): Bolt {
      const startX = W * 0.35 + Math.random() * W * 0.3;
      const segments = generateBoltPath(startX, -10, H + 10, 45, 14);
      const branches: Branch[] = [];

      // Add 2-4 branches
      const branchCount = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < branchCount; i++) {
        const idx = 2 + Math.floor(Math.random() * 8);
        const dir = Math.random() > 0.5 ? 1 : -1;
        branches.push({
          segments: generateBranch(segments, idx, dir),
          startIndex: idx,
          progress: 0,
          opacity: 0.6 + Math.random() * 0.3,
          width: 1 + Math.random() * 1.5,
        });
      }

      return {
        segments,
        progress: 0,
        opacity: 1,
        width: 2.5 + Math.random() * 1.5,
        phase: "strike",
        holdTime: 0,
        fadeTime: 0,
        branches,
        color: Math.random() > 0.3 ? "#FFD93D" : "#FFFFFF",
      };
    }

    function drawBoltPath(
      ctx: CanvasRenderingContext2D,
      segments: { x: number; y: number }[],
      progress: number,
      width: number,
      opacity: number,
      color: string
    ) {
      const count = Math.floor(segments.length * progress);
      if (count < 2) return;

      // Outer glow
      ctx.save();
      ctx.globalAlpha = opacity * 0.4;
      ctx.strokeStyle = color;
      ctx.lineWidth = width + 12;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.shadowColor = color;
      ctx.shadowBlur = 30;
      ctx.beginPath();
      ctx.moveTo(segments[0].x, segments[0].y);
      for (let i = 1; i < count; i++) {
        ctx.lineTo(segments[i].x, segments[i].y);
      }
      ctx.stroke();
      ctx.restore();

      // Mid glow
      ctx.save();
      ctx.globalAlpha = opacity * 0.6;
      ctx.strokeStyle = "#FFF3B0";
      ctx.lineWidth = width + 4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.shadowColor = "#FFD93D";
      ctx.shadowBlur = 15;
      ctx.beginPath();
      ctx.moveTo(segments[0].x, segments[0].y);
      for (let i = 1; i < count; i++) {
        ctx.lineTo(segments[i].x, segments[i].y);
      }
      ctx.stroke();
      ctx.restore();

      // Core white
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.strokeStyle = "#FFFFFF";
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(segments[0].x, segments[0].y);
      for (let i = 1; i < count; i++) {
        ctx.lineTo(segments[i].x, segments[i].y);
      }
      ctx.stroke();
      ctx.restore();
    }

    function spawnSparks(x: number, y: number, count: number) {
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 1 + Math.random() * 4;
        sparkParticles.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 2,
          life: 1,
          maxLife: 0.3 + Math.random() * 0.5,
          size: 1 + Math.random() * 2.5,
        });
      }
    }

    // Animation loop
    let lastTime = 0;
    function animate(time: number) {
      const dt = Math.min((time - lastTime) / 1000, 0.05);
      lastTime = time;
      timer += dt;

      ctx.clearRect(0, 0, W, H);

      // Ambient glow behind everything
      const ambientGrad = ctx.createRadialGradient(
        W * 0.5, H * 0.4, 0,
        W * 0.5, H * 0.4, W * 0.45
      );
      const ambientPulse = 0.03 + Math.sin(timer * 1.5) * 0.015;
      ambientGrad.addColorStop(0, `rgba(255, 217, 61, ${ambientPulse})`);
      ambientGrad.addColorStop(1, "rgba(255, 217, 61, 0)");
      ctx.fillStyle = ambientGrad;
      ctx.fillRect(0, 0, W, H);

      // Trigger new strikes
      if (timer >= nextStrikeAt) {
        bolts.push(createBolt());
        nextStrikeAt = timer + 0.8 + Math.random() * 1.5;
      }

      // Update and draw bolts
      for (let b = bolts.length - 1; b >= 0; b--) {
        const bolt = bolts[b];

        if (bolt.phase === "strike") {
          bolt.progress += dt * 4.5; // Fast strike down
          if (bolt.progress >= 1) {
            bolt.progress = 1;
            bolt.phase = "hold";
            bolt.holdTime = 0;
            // Sparks at the tip
            const tip = bolt.segments[bolt.segments.length - 1];
            spawnSparks(tip.x, tip.y, 12);
            // Sparks at branch tips
            for (const branch of bolt.branches) {
              if (branch.segments.length > 0) {
                const btip = branch.segments[branch.segments.length - 1];
                spawnSparks(btip.x, btip.y, 5);
              }
            }
          }
          // Update branches that should have started
          for (const branch of bolt.branches) {
            const triggerAt = branch.startIndex / bolt.segments.length;
            if (bolt.progress > triggerAt) {
              branch.progress = Math.min(
                1,
                (bolt.progress - triggerAt) / (1 - triggerAt) * 1.5
              );
            }
          }
        } else if (bolt.phase === "hold") {
          bolt.holdTime += dt;
          // Flicker during hold
          bolt.opacity = 0.7 + Math.random() * 0.3;
          if (bolt.holdTime > 0.1 + Math.random() * 0.15) {
            bolt.phase = "fade";
            bolt.fadeTime = 0;
          }
        } else if (bolt.phase === "fade") {
          bolt.fadeTime += dt;
          bolt.opacity = Math.max(0, 1 - bolt.fadeTime / 0.35);
          if (bolt.opacity <= 0) {
            bolts.splice(b, 1);
            continue;
          }
        }

        // Flash effect during strike
        if (bolt.phase === "strike" || bolt.phase === "hold") {
          const flashAlpha =
            bolt.phase === "hold"
              ? 0.06 * bolt.opacity
              : 0.03 * bolt.progress;
          ctx.save();
          ctx.globalAlpha = flashAlpha;
          ctx.fillStyle = "#FFD93D";
          ctx.fillRect(0, 0, W, H);
          ctx.restore();
        }

        // Draw main bolt
        drawBoltPath(
          ctx,
          bolt.segments,
          bolt.progress,
          bolt.width,
          bolt.opacity,
          bolt.color
        );

        // Draw branches
        for (const branch of bolt.branches) {
          if (branch.progress > 0) {
            drawBoltPath(
              ctx,
              branch.segments,
              branch.progress,
              branch.width,
              bolt.opacity * branch.opacity,
              bolt.color
            );
          }
        }
      }

      // Update and draw sparks
      for (let i = sparkParticles.length - 1; i >= 0; i--) {
        const s = sparkParticles[i];
        s.x += s.vx;
        s.y += s.vy;
        s.vy += 5 * dt; // gravity
        s.life -= dt / s.maxLife;

        if (s.life <= 0) {
          sparkParticles.splice(i, 1);
          continue;
        }

        ctx.save();
        ctx.globalAlpha = s.life;
        ctx.fillStyle = "#FFD93D";
        ctx.shadowColor = "#FFD93D";
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size * s.life, 0, Math.PI * 2);
        ctx.fill();
        // White center
        ctx.fillStyle = "#FFFFFF";
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size * s.life * 0.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      frameRef.current = requestAnimationFrame(animate);
    }

    // Start with an initial strike
    nextStrikeAt = 0.2;
    frameRef.current = requestAnimationFrame(animate);

    return () => cancelAnimationFrame(frameRef.current);
  }, []);

  useEffect(() => {
    const cleanup = draw();
    return cleanup;
  }, [draw]);

  return (
    <div className="relative w-[420px] h-[520px] select-none">
      <canvas
        ref={canvasRef}
        width={420}
        height={520}
        className="w-full h-full"
      />
    </div>
  );
}
