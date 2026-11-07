export function PlanDiagram({ compact = false }: { compact?: boolean }) {
  return (
    <svg
      className={`plan ${compact ? 'plan--compact' : ''}`}
      viewBox="0 0 640 400"
      role="img"
      aria-label="Схема зала 20 на 10 метров с пятью поверхностями"
    >
      <defs>
        <pattern id="plan-grid" width="23" height="23" patternUnits="userSpaceOnUse">
          <path d="M23 0H0V23" fill="none" stroke="currentColor" strokeOpacity="0.09" />
        </pattern>
        <linearGradient id="plan-floor" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ff5a36" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#ff5a36" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      <g className="plan__grid">
        <rect x="90" y="80" width="460" height="230" fill="url(#plan-grid)" />
        <rect x="90" y="80" width="460" height="230" fill="url(#plan-floor)" />
      </g>

      <g className="plan__walls">
        <rect x="90" y="71" width="460" height="9" rx="2" />
        <rect x="90" y="310" width="460" height="9" rx="2" />
        <rect x="81" y="80" width="9" height="230" rx="2" />
        <rect x="550" y="80" width="9" height="230" rx="2" />
      </g>

      <g className="plan__labels">
        <g transform="translate(320 52)">
          <circle r="10" />
          <text y="3.5">1</text>
          <text className="plan__name" x="20" y="4">RIGHT</text>
        </g>
        <g transform="translate(592 195)">
          <circle r="10" />
          <text y="3.5">2</text>
          <text className="plan__name" x="16" y="4">BACK</text>
        </g>
        <g transform="translate(320 340)">
          <circle r="10" />
          <text y="3.5">3</text>
          <text className="plan__name" x="-16" y="4" textAnchor="end">LEFT</text>
        </g>
        <g transform="translate(44 195)">
          <circle r="10" />
          <text y="3.5">4</text>
          <text className="plan__name" x="0" y="-18" textAnchor="middle">CENTER</text>
        </g>
        <g transform="translate(320 195)">
          <circle r="10" className="plan__circle--floor" />
          <text y="3.5">5</text>
          <text className="plan__name" x="0" y="-24" textAnchor="middle">FLOOR</text>
          <text className="plan__dims" x="0" y="30" textAnchor="middle">4 800 × 2 400</text>
        </g>
      </g>

      <g className="plan__zones">
        <text x="90" y="62">ТЕХНИЧЕСКАЯ ЗОНА</text>
        <text x="550" y="30" textAnchor="end">ЗАЛ 20 × 10 М · ВЫСОТА 5 М</text>
        <text x="550" y="367" textAnchor="end">ГАРДЕРОБ · GALLERY</text>
      </g>
    </svg>
  );
}
