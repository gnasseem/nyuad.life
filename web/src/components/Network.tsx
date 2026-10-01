import { useEffect, useRef } from 'react';

/**
 * A ghost of the network down both edges of the screen: the five lines, the current section's line burning
 * brightest with a light travelling along it, and a brighter copy of the map revealed around the pointer. Each side
 * is anchored to its own edge, so the lines stay in the margins at any width and reach further in as the margins grow.
 */
type Line = { l: string; d: string; stops: Array<[number, number]> };

const LEFT: Line[] = [
  { l: 'ask', d: 'M 64 -40 V 150 L 150 236 V 520 L 58 612 V 1040', stops: [[150, 340], [58, 760], [58, 905]] },
  { l: 'notices', d: 'M -40 430 H 196 L 262 496 V 1040', stops: [[110, 430], [262, 720]] },
  { l: 'market', d: 'M -40 890 H 120 L 230 1000 V 1040', stops: [[40, 890]] },
];
const RIGHT: Line[] = [
  { l: 'questions', d: 'M 236 -40 V 160 L 150 246 V 560 L 244 654 V 1040', stops: [[150, 380], [244, 770], [244, 930]] },
  { l: 'guide', d: 'M 340 470 H 116 L 36 550 V 820 L 116 900 H 340', stops: [[214, 470], [36, 690], [226, 900]] },
];

function Side({ lines, side, pulses }: { lines: Line[]; side: 'left' | 'right'; pulses: boolean }) {
  return (
    <svg className={`net-side ${side}`} viewBox="0 0 300 1000" preserveAspectRatio={side === 'left' ? 'xMinYMid slice' : 'xMaxYMid slice'}>
      {lines.map((line) => (
        <path key={line.l} className="ln" data-l={line.l} d={line.d} />
      ))}
      {pulses && lines.map((line) => <path key={`p-${line.l}`} className="pulse" data-l={line.l} d={line.d} pathLength={1000} />)}
      {lines.flatMap((line) => line.stops.map(([x, y]) => <circle key={`${line.l}-${x}-${y}`} className="st" data-l={line.l} cx={x} cy={y} r={9} />))}
    </svg>
  );
}

export function Network() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    let frame = 0;
    let x = -400;
    let y = -400;
    const onMove = (event: PointerEvent) => {
      x = event.clientX;
      y = event.clientY;
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        element.style.setProperty('--mx', `${x}px`);
        element.style.setProperty('--my', `${y}px`);
      });
    };
    const onLeave = () => {
      element.style.setProperty('--mx', '-400px');
      element.style.setProperty('--my', '-400px');
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div ref={ref} className="net" aria-hidden="true">
      <div className="net-layer">
        <Side lines={LEFT} side="left" pulses />
        <Side lines={RIGHT} side="right" pulses />
      </div>
      <div className="net-layer net-reveal">
        <Side lines={LEFT} side="left" pulses={false} />
        <Side lines={RIGHT} side="right" pulses={false} />
      </div>
    </div>
  );
}
