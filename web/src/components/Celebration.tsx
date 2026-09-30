import { useEffect, useRef } from 'react';

interface Props {
  title: string;
  message: string;
  action?: string;
  onClose(): void;
}

const COLOURS = ['#6c3de0', '#c04ac7', '#f5a524', '#1a9c96', '#ef5a4c', '#a98cff', '#fffdf9'];

/** A short burst of confetti behind a small card. Respects reduced-motion settings by skipping the animation. */
export function Celebration({ title, message, action = 'Nice', onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const scale = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      canvas.width = window.innerWidth * scale;
      canvas.height = window.innerHeight * scale;
    };
    resize();
    window.addEventListener('resize', resize);
    const pieces = Array.from({ length: 160 }, () => ({
      x: Math.random() * canvas.width,
      y: -Math.random() * canvas.height * 0.3,
      vx: (Math.random() - 0.5) * 3 * scale,
      vy: (2 + Math.random() * 3) * scale,
      size: (5 + Math.random() * 6) * scale,
      tilt: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.25,
      colour: COLOURS[Math.floor(Math.random() * COLOURS.length)]!,
    }));
    const started = performance.now();
    let frame = 0;
    const draw = (now: number) => {
      const elapsed = now - started;
      context.clearRect(0, 0, canvas.width, canvas.height);
      const fade = elapsed < 2400 ? 1 : Math.max(0, 1 - (elapsed - 2400) / 900);
      for (const piece of pieces) {
        piece.x += piece.vx;
        piece.y += piece.vy;
        piece.vy += 0.03 * scale;
        piece.vx *= 0.995;
        piece.tilt += piece.spin;
        context.save();
        context.globalAlpha = fade;
        context.translate(piece.x, piece.y);
        context.rotate(piece.tilt);
        context.fillStyle = piece.colour;
        context.fillRect(-piece.size / 2, -piece.size / 4, piece.size, piece.size / 2);
        context.restore();
      }
      if (elapsed < 3400) frame = requestAnimationFrame(draw);
      else context.clearRect(0, 0, canvas.width, canvas.height);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <div className="celebration" role="dialog" aria-modal="true" aria-labelledby="celebration-title">
      <canvas ref={canvasRef} className="confetti" aria-hidden="true" />
      <div className="celebration-card">
        <h2 id="celebration-title">{title}</h2>
        <p>{message}</p>
        <button type="button" className="btn primary" onClick={onClose} autoFocus>
          {action}
        </button>
      </div>
    </div>
  );
}
