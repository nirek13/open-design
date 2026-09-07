/**
 * Packaged/dev startup splash. Inline HTML with no network and no on-disk
 * assets: the window appears before daemon/web are up. Theme is injected from
 * Electron `nativeTheme` so light and dark both look intentional, with
 * `prefers-color-scheme` as a fallback if the class is missing.
 */

export type SplashTheme = "light" | "dark";

export type SplashHtmlInput = {
  initialPct: number;
  label: string;
  step: number;
  theme: SplashTheme;
  total: number;
};

const SPLASH_BACKGROUND: Record<SplashTheme, string> = {
  dark: "#0c0b0a",
  light: "#f3eee6",
};

export function resolveSplashTheme(shouldUseDarkColors: boolean): SplashTheme {
  return shouldUseDarkColors ? "dark" : "light";
}

export function splashWindowBackground(theme: SplashTheme): string {
  return SPLASH_BACKGROUND[theme];
}

export function createSplashDataUrl(input: SplashHtmlInput): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(renderSplashHtml(input))}`;
}

function renderSplashHtml(input: SplashHtmlInput): string {
  const { theme, step, total, label, initialPct } = input;
  return `<!doctype html>
<html class="theme-${theme}" lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="light dark" />
    <title>Plyxl</title>
    <style>
      :root {
        --accent: #c96442;
        --ease: cubic-bezier(0.23, 1, 0.32, 1);
      }
      html.theme-light {
        color-scheme: light;
        --bg: #f3eee6;
        --fg: #1a1916;
        --fg-soft: rgba(26, 25, 22, 0.52);
        --fg-faint: rgba(26, 25, 22, 0.32);
        --lamp: rgba(201, 100, 66, 0.26);
        --lamp-core: rgba(255, 250, 244, 0.72);
        --ring: rgba(26, 25, 22, 0.1);
        --glow: rgba(201, 100, 66, 0.28);
        --shine: rgba(255, 255, 255, 0.72);
        --vignette: rgba(92, 58, 38, 0.1);
        --track: rgba(26, 25, 22, 0.1);
        --grain: 0.035;
      }
      html.theme-dark {
        color-scheme: dark;
        --bg: #0c0b0a;
        --fg: #f4efe6;
        --fg-soft: rgba(244, 239, 230, 0.58);
        --fg-faint: rgba(244, 239, 230, 0.3);
        --lamp: rgba(201, 100, 66, 0.4);
        --lamp-core: rgba(244, 239, 230, 0.08);
        --ring: rgba(244, 239, 230, 0.16);
        --glow: rgba(201, 100, 66, 0.55);
        --shine: rgba(255, 252, 246, 0.5);
        --vignette: rgba(0, 0, 0, 0.48);
        --track: rgba(244, 239, 230, 0.1);
        --grain: 0.045;
      }
      @media (prefers-color-scheme: dark) {
        html:not(.theme-light) {
          color-scheme: dark;
          --bg: #0c0b0a;
          --fg: #f4efe6;
          --fg-soft: rgba(244, 239, 230, 0.58);
          --fg-faint: rgba(244, 239, 230, 0.3);
          --lamp: rgba(201, 100, 66, 0.4);
          --lamp-core: rgba(244, 239, 230, 0.08);
          --ring: rgba(244, 239, 230, 0.16);
          --glow: rgba(201, 100, 66, 0.55);
          --shine: rgba(255, 252, 246, 0.5);
          --vignette: rgba(0, 0, 0, 0.48);
          --track: rgba(244, 239, 230, 0.1);
          --grain: 0.045;
        }
      }
      html, body {
        background: var(--bg);
        height: 100%;
        margin: 0;
        overflow: hidden;
      }
      body {
        align-items: center;
        color: var(--fg);
        display: flex;
        justify-content: center;
      }
      .stage {
        align-items: center;
        display: flex;
        height: 100%;
        justify-content: center;
        position: relative;
        width: 100%;
      }
      .vignette {
        background: radial-gradient(ellipse at center, transparent 42%, var(--vignette) 100%);
        inset: 0;
        pointer-events: none;
        position: absolute;
      }
      .lamp {
        animation: lamp-in 2.4s var(--ease) both, lamp-breathe 7.5s var(--ease) 2.2s infinite alternate;
        background: radial-gradient(ellipse at center, var(--lamp) 0%, transparent 70%);
        border-radius: 50%;
        filter: blur(12px);
        height: min(78vw, 760px);
        left: 50%;
        pointer-events: none;
        position: absolute;
        top: 40%;
        transform: translate(-50%, -50%);
        width: min(110vw, 1100px);
      }
      .lamp-core {
        animation: lamp-in 2.6s var(--ease) 0.18s both;
        background: radial-gradient(circle, var(--lamp-core) 0%, transparent 68%);
        height: min(34vw, 340px);
        top: 44%;
        width: min(34vw, 340px);
      }
      .ring {
        animation: ring-out 3.6s var(--ease) 0.55s both;
        border: 1px solid var(--ring);
        border-radius: 50%;
        height: 96px;
        left: 50%;
        pointer-events: none;
        position: absolute;
        top: 41%;
        width: 96px;
      }
      .grain {
        animation: grain-in 2s var(--ease) 0.4s both;
        height: 100%;
        left: 0;
        mix-blend-mode: overlay;
        opacity: var(--grain);
        pointer-events: none;
        position: absolute;
        top: 0;
        width: 100%;
      }
      .lockup {
        align-items: center;
        animation: lockup-rise 4.2s var(--ease) both;
        display: flex;
        flex-direction: column;
        position: relative;
        text-align: center;
        user-select: none;
        z-index: 1;
      }
      .mark-wrap {
        animation: mark-in 1.6s var(--ease) 0.7s both;
        filter: drop-shadow(0 12px 40px var(--glow));
        height: 88px;
        margin-bottom: 28px;
        overflow: hidden;
        position: relative;
        width: 88px;
      }
      .mark {
        color: var(--fg);
        display: block;
        height: 100%;
        width: 100%;
      }
      .shine {
        animation: shine-sweep 1.8s var(--ease) 1.9s both;
        background: linear-gradient(115deg, transparent 38%, var(--shine) 50%, transparent 62%);
        inset: -40%;
        pointer-events: none;
        position: absolute;
      }
      .wordmark {
        color: var(--fg);
        display: flex;
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        font-size: 92px;
        font-weight: 600;
        gap: 0.012em;
        letter-spacing: -0.058em;
        line-height: 0.92;
        margin: 0 0 18px;
      }
      .wordmark span {
        animation: letter-in 1.15s var(--ease) both;
        animation-delay: calc(1.25s + var(--i) * 0.13s);
        display: inline-block;
      }
      .rule {
        animation: rule-draw 1.5s var(--ease) 2.2s both;
        background: linear-gradient(90deg, transparent, var(--accent), transparent);
        height: 1px;
        margin: 0 0 18px;
        transform-origin: center;
        width: min(11rem, 40vw);
      }
      .tagline {
        animation: tag-in 1.4s var(--ease) 2.55s both;
        color: var(--fg-soft);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        font-weight: 500;
        letter-spacing: 0.18em;
        line-height: 1.5;
        margin: 0;
      }
      .veil {
        animation: veil-lift 1.7s var(--ease) both;
        background: var(--bg);
        inset: 0;
        pointer-events: none;
        position: absolute;
        z-index: 4;
      }
      .boot-stage {
        animation: bar-in 1s var(--ease) 1.4s both;
        bottom: 56px;
        color: var(--fg-soft);
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        font-size: 12px;
        left: 0;
        letter-spacing: 0.04em;
        position: fixed;
        right: 0;
        text-align: center;
        transition: opacity 200ms var(--ease);
        user-select: none;
        z-index: 5;
      }
      .boot-stage-swapping {
        opacity: 0;
        transition-duration: 140ms;
      }
      .boot-stage-step {
        color: var(--fg-faint);
        font-variant-numeric: tabular-nums;
        margin-right: 7px;
      }
      .boot-progress {
        animation: bar-in 1s var(--ease) 1.35s both;
        background: var(--track);
        border-radius: 999px;
        bottom: 84px;
        height: 1px;
        left: 50%;
        overflow: hidden;
        position: fixed;
        transform: translateX(-50%);
        width: 168px;
        z-index: 5;
      }
      .boot-progress-fill {
        background: var(--accent);
        border-radius: 999px;
        height: 100%;
        transition: width 420ms var(--ease);
      }
      .boot-dots .dot {
        animation: boot-dot 1.6s var(--ease) infinite;
        display: inline-block;
      }
      .boot-dots .dot:nth-child(2) { animation-delay: 0.22s; }
      .boot-dots .dot:nth-child(3) { animation-delay: 0.44s; }
      @keyframes veil-lift {
        from { opacity: 1; }
        to { opacity: 0; }
      }
      @keyframes lamp-in {
        from { opacity: 0; transform: translate(-50%, -50%) scale(0.94); }
        to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      }
      @keyframes lamp-breathe {
        from { transform: translate(-50%, -50%) scale(1); }
        to { transform: translate(-50%, -48%) scale(1.04); }
      }
      @keyframes ring-out {
        from { opacity: 0.45; transform: translate(-50%, -50%) scale(0.94); }
        to { opacity: 0; transform: translate(-50%, -50%) scale(3.1); }
      }
      @keyframes grain-in {
        from { opacity: 0; }
        to { opacity: var(--grain); }
      }
      @keyframes lockup-rise {
        from { opacity: 0.85; transform: scale(0.97) translateY(10px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }
      @keyframes mark-in {
        from { opacity: 0; transform: scale(0.94) translateY(10px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }
      @keyframes shine-sweep {
        from { transform: translateX(-38%); opacity: 0; }
        18% { opacity: 1; }
        to { transform: translateX(38%); opacity: 0; }
      }
      @keyframes letter-in {
        from { opacity: 0; transform: translateY(16px); filter: blur(8px); }
        to { opacity: 1; transform: translateY(0); filter: blur(0); }
      }
      @keyframes rule-draw {
        from { opacity: 0; transform: scaleX(0.12); }
        to { opacity: 1; transform: scaleX(1); }
      }
      @keyframes tag-in {
        from { opacity: 0; letter-spacing: 0.34em; }
        to { opacity: 1; letter-spacing: 0.18em; }
      }
      @keyframes bar-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes boot-dot {
        0%, 60%, 100% { opacity: 0.22; }
        30% { opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        .veil, .lamp, .lamp-core, .ring, .grain, .lockup, .mark-wrap, .shine,
        .wordmark span, .rule, .tagline, .boot-progress, .boot-stage {
          animation: none !important;
          filter: none;
          letter-spacing: 0.18em;
          opacity: 1;
          transform: none;
        }
        .veil { display: none; }
      }
    </style>
  </head>
  <body>
    <div class="stage">
      <div class="lamp" aria-hidden="true"></div>
      <div class="lamp lamp-core" aria-hidden="true"></div>
      <div class="ring" aria-hidden="true"></div>
      <svg class="grain" aria-hidden="true" preserveAspectRatio="none" width="100%" height="100%">
        <filter id="plyxl-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" stitchTiles="stitch"/>
        </filter>
        <rect width="100%" height="100%" filter="url(#plyxl-grain)"/>
      </svg>
      <div class="vignette" aria-hidden="true"></div>
      <div class="lockup">
        <div class="mark-wrap">
          <svg class="mark" viewBox="0 0 82 82" aria-hidden="true">
            <path fill="currentColor" fill-rule="evenodd" d="M18 8c0-2.2 1.8-4 4-4h28c16.6 0 30 13.4 30 30S66.6 64 50 64H36v10c0 2.2-1.8 4-4 4h-10c-2.2 0-4-1.8-4-4V8zm18 12v28h14c8.8 0 16-7.2 16-16s-7.2-16-16-16H36z"/>
          </svg>
          <span class="shine" aria-hidden="true"></span>
        </div>
        <h1 class="wordmark" aria-label="Plyxl"><span style="--i:0">P</span><span style="--i:1">l</span><span style="--i:2">y</span><span style="--i:3">x</span><span style="--i:4">l</span></h1>
        <div class="rule" aria-hidden="true"></div>
        <p class="tagline">The Future Of Work</p>
      </div>
      <div class="veil" aria-hidden="true"></div>
    </div>
    <div class="boot-progress" aria-hidden="true">
      <div class="boot-progress-fill" id="boot-progress-fill" data-pct="${initialPct}" style="width: ${initialPct}%;"></div>
    </div>
    <div class="boot-stage" id="boot-stage" aria-live="polite">
      <span class="boot-stage-step" id="boot-stage-step">${step}/${total}</span><span id="boot-stage-text">${escapeHtml(label)}</span><span class="boot-dots" aria-hidden="true"><span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></span>
    </div>
    <script>
      window.__odSplashSetStage = function (info) {
        var data = (typeof info === "string") ? { label: info } : (info || {});
        var wrap = document.getElementById("boot-stage");
        var text = document.getElementById("boot-stage-text");
        var stepEl = document.getElementById("boot-stage-step");
        var fill = document.getElementById("boot-progress-fill");
        if (!wrap || !text) return;
        var nextStep = (typeof data.step === "number") ? data.step : null;
        var nextTotal = (typeof data.total === "number" && data.total > 0) ? data.total : null;
        if (fill && nextStep != null && nextTotal != null) {
          var pct = Math.max(0, Math.min(100, Math.round((nextStep / nextTotal) * 100)));
          var prev = parseFloat(fill.getAttribute("data-pct")) || 0;
          if (pct >= prev) {
            fill.style.width = pct + "%";
            fill.setAttribute("data-pct", String(pct));
          }
        }
        var nextLabel = (typeof data.label === "string") ? data.label : null;
        var stepText = (nextStep != null && nextTotal != null) ? (nextStep + "/" + nextTotal) : null;
        var labelSame = (nextLabel == null) || text.textContent === nextLabel;
        var stepSame = (stepText == null) || !stepEl || stepEl.textContent === stepText;
        if (labelSame && stepSame) return;
        wrap.classList.add("boot-stage-swapping");
        setTimeout(function () {
          if (nextLabel != null) text.textContent = nextLabel;
          if (stepEl && stepText != null) stepEl.textContent = stepText;
          wrap.classList.remove("boot-stage-swapping");
        }, 140);
      };
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
