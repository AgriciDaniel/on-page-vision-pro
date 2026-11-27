import React, { useCallback, useMemo } from 'react';

interface WarpBackgroundProps {
  children?: React.ReactNode;
  className?: string;
  perspective?: number;
  beamsPerSide?: number;
  beamSize?: number;
  beamDuration?: number;
  gridColor?: string;
}

interface BeamProps {
  width: string;
  x: string;
  delay: number;
  duration: number;
  hue: number;
  ar: number;
  reverse?: boolean;
}

// Plain CSS animation (keyframes in index.css): the beam travels from the far edge to the center
// of its plane, linear and forever, and stays put for people who prefer reduced motion.
const Beam: React.FC<BeamProps> = React.memo(
  ({ width, x, delay, duration, hue, ar, reverse = false }) => (
    <div
      style={{
        left: x,
        width,
        aspectRatio: `1 / ${ar}`,
        background: reverse
          ? `linear-gradient(transparent, hsl(${hue} 85% 60%))`
          : `linear-gradient(hsl(${hue} 85% 60%), transparent)`,
        animation: `${reverse ? 'warp-beam-reverse' : 'warp-beam'} ${duration}s linear ${delay}s infinite both`,
      }}
      className="warp-beam absolute top-0 rounded-full"
    />
  )
);

Beam.displayName = 'Beam';

// Vibrant original multicolor warp beam hues (blue, coral, amber, emerald, violet, magenta, cyan)
const VIBRANT_HUES = [214, 355, 34, 152, 272, 326, 192, 48, 240, 12];

export const WarpBackground: React.FC<WarpBackgroundProps> = ({
  children,
  className = '',
  perspective = 200,
  beamsPerSide = 4,
  beamSize = 4,
  beamDuration = 4,
  gridColor = 'rgba(26, 115, 232, 0.15)',
}) => {
  const generateBeams = useCallback(
    (seedOffset: number) => {
      const cellsPerSide = Math.floor(100 / beamSize);
      const step = Math.max(1, Math.floor(cellsPerSide / beamsPerSide));
      return Array.from({ length: beamsPerSide }, (_, i) => {
        const xCell = (i * step + ((seedOffset * 3 + i * 2) % step)) % cellsPerSide;
        const delay = (i * 1.15 + seedOffset * 0.7) % beamDuration;
        const hue = VIBRANT_HUES[(i * 2 + seedOffset * 3) % VIBRANT_HUES.length];
        const ar = 4 + ((i + seedOffset) % 5);
        return { xCell, delay, hue, ar };
      });
    },
    [beamsPerSide, beamSize, beamDuration]
  );

  const topBeams = useMemo(() => generateBeams(0), [generateBeams]);
  const rightBeams = useMemo(() => generateBeams(1), [generateBeams]);
  const bottomBeams = useMemo(() => generateBeams(2), [generateBeams]);
  const leftBeams = useMemo(() => generateBeams(3), [generateBeams]);

  const gridBgStyle = (size: number): React.CSSProperties => ({
    backgroundImage: `linear-gradient(${gridColor} 0 1px, transparent 1px ${size}%), linear-gradient(90deg, ${gridColor} 0 1px, transparent 1px ${size}%)`,
    backgroundSize: `${size}% ${size}%`,
    backgroundPosition: '50% -0.5px, 50% 50%',
  });

  return (
    <div className={`relative overflow-hidden ${className}`}>
      <div
        style={{ perspective: `${perspective}px` }}
        className="pointer-events-none absolute inset-0 overflow-hidden [clip-path:inset(0)] [container-type:size] [transform-style:preserve-3d]"
      >
        {/* Top Plane: beams streak strictly outwards (center -> top edge) */}
        <div
          style={{
            ...gridBgStyle(beamSize),
            transform: 'rotateX(-90deg)',
            transformOrigin: '50% 0%',
          }}
          className="absolute inset-x-0 top-0 h-[100cqmax] w-[100cqi] [container-type:inline-size] [transform-style:preserve-3d]"
        >
          {topBeams.map((b, i) => (
            <Beam
              key={`top-${i}`}
              width={`${beamSize}%`}
              x={`${b.xCell * beamSize}%`}
              delay={b.delay}
              duration={beamDuration}
              hue={b.hue}
              ar={b.ar}
            />
          ))}
        </div>

        {/* Bottom Plane: reversed travel so beams streak strictly outwards (center -> bottom edge) */}
        <div
          style={{
            ...gridBgStyle(beamSize),
            transform: 'rotateX(90deg)',
            transformOrigin: '50% 100%',
          }}
          className="absolute inset-x-0 bottom-0 h-[100cqmax] w-[100cqi] [container-type:inline-size] [transform-style:preserve-3d]"
        >
          {bottomBeams.map((b, i) => (
            <Beam
              key={`bottom-${i}`}
              width={`${beamSize}%`}
              x={`${b.xCell * beamSize}%`}
              delay={b.delay}
              duration={beamDuration}
              hue={b.hue}
              ar={b.ar}
              reverse
            />
          ))}
        </div>

        {/* Left Plane: beams streak strictly outwards (center -> left edge) */}
        <div
          style={{
            ...gridBgStyle(beamSize),
            transform: 'rotate(90deg) rotateX(-90deg)',
            transformOrigin: '0% 0%',
          }}
          className="absolute left-0 top-0 h-[100cqmax] w-[100cqh] [container-type:inline-size] [transform-style:preserve-3d]"
        >
          {leftBeams.map((b, i) => (
            <Beam
              key={`left-${i}`}
              width={`${beamSize}%`}
              x={`${b.xCell * beamSize}%`}
              delay={b.delay}
              duration={beamDuration}
              hue={b.hue}
              ar={b.ar}
            />
          ))}
        </div>

        {/* Right Plane: beams streak strictly outwards (center -> right edge) */}
        <div
          style={{
            ...gridBgStyle(beamSize),
            transform: 'rotate(-90deg) rotateX(-90deg)',
            transformOrigin: '100% 0%',
          }}
          className="absolute right-0 top-0 h-[100cqmax] w-[100cqh] [container-type:inline-size] [transform-style:preserve-3d]"
        >
          {rightBeams.map((b, i) => (
            <Beam
              key={`right-${i}`}
              width={`${beamSize}%`}
              x={`${b.xCell * beamSize}%`}
              delay={b.delay}
              duration={beamDuration}
              hue={b.hue}
              ar={b.ar}
            />
          ))}
        </div>
      </div>

      {/* Subtle center radial veil so beams emerge smoothly outward from behind the hero headline */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_48%_42%_at_50%_46%,rgba(240,244,248,0.92)_0%,rgba(240,244,248,0.55)_52%,rgba(240,244,248,0)_100%)]" />

      <div className="relative z-10 w-full h-full">{children}</div>
    </div>
  );
};
