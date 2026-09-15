/**
 * Outside Orchestrator — Operator Web Dashboard
 * Lightweight, zero-dependency operator web UI (Contract §1, §4, §6.8, §9 & §10 AC 9, 10).
 * Self-contained HTML5, Vanilla CSS3, and modern Vanilla ES6+ SPA.
 */

export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Outside Orchestrator — Control Plane Operator UI</title>
  <style>
    :root {
      --bg-base: #070a12;
      --bg-surface: rgba(15, 22, 38, 0.75);
      --bg-surface-hover: rgba(26, 38, 64, 0.75);
      --bg-elevated: rgba(30, 41, 67, 0.85);
      --border-subtle: rgba(255, 255, 255, 0.08);
      --border-glow: rgba(0, 240, 255, 0.25);
      --text-main: #f1f5f9;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --cyan: #00f0ff;
      --cyan-glow: rgba(0, 240, 255, 0.4);
      --emerald: #10b981;
      --emerald-glow: rgba(16, 185, 129, 0.3);
      --violet: #a855f7;
      --amber: #f59e0b;
      --rose: #f43f5e;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-base);
      background-image: 
        radial-gradient(circle at 15% 15%, rgba(0, 240, 255, 0.05) 0%, transparent 40%),
        radial-gradient(circle at 85% 20%, rgba(168, 85, 247, 0.05) 0%, transparent 40%),
        radial-gradient(circle at 50% 80%, rgba(16, 185, 129, 0.03) 0%, transparent 50%);
      color: var(--text-main);
      font-family: var(--font-sans);
      min-height: 100vh;
      overflow-x: hidden;
      display: flex;
      flex-direction: column;
    }

    /* Top Navigation Header */
    header {
      background: rgba(11, 17, 30, 0.85);
      backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--border-subtle);
      padding: 0.85rem 1.75rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 50;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 0.85rem;
    }

    .brand-logo {
      width: 32px;
      height: 32px;
      background: linear-gradient(135deg, var(--cyan), var(--violet));
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 15px var(--cyan-glow);
    }

    .brand-title {
      font-size: 1.1rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      color: #fff;
    }

    .brand-badge {
      font-size: 0.7rem;
      font-weight: 600;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      background: rgba(0, 240, 255, 0.12);
      color: var(--cyan);
      border: 1px solid rgba(0, 240, 255, 0.3);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .header-controls {
      display: flex;
      align-items: center;
      gap: 1.25rem;
    }

    .status-pill {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--emerald);
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.25);
      padding: 0.35rem 0.75rem;
      border-radius: 9999px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--emerald);
      box-shadow: 0 0 8px var(--emerald);
      animation: pulse 2s infinite ease-in-out;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }

    .btn {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      color: var(--text-main);
      padding: 0.45rem 0.95rem;
      border-radius: 6px;
      font-size: 0.825rem;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      transition: all 0.2s ease;
      font-family: inherit;
    }

    .btn:hover {
      background: var(--bg-surface-hover);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .btn-primary {
      background: linear-gradient(135deg, rgba(0, 240, 255, 0.2), rgba(168, 85, 247, 0.2));
      border-color: var(--cyan);
      color: #fff;
    }

    .btn-primary:hover {
      background: linear-gradient(135deg, rgba(0, 240, 255, 0.3), rgba(168, 85, 247, 0.3));
      box-shadow: 0 0 12px var(--cyan-glow);
    }

    .btn-emerald {
      background: linear-gradient(135deg, rgba(16, 185, 129, 0.2), rgba(5, 150, 105, 0.2));
      border-color: var(--emerald);
      color: #fff;
    }

    .btn-emerald:hover {
      box-shadow: 0 0 12px var(--emerald-glow);
    }

    /* Main Container */
    main {
      flex: 1;
      padding: 1.5rem 1.75rem;
      max-width: 1600px;
      margin: 0 auto;
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }

    /* KPI Summary Row */
    .kpi-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 1rem;
    }

    .kpi-card {
      background: var(--bg-surface);
      backdrop-filter: blur(12px);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      padding: 1.15rem;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      position: relative;
      overflow: hidden;
    }

    .kpi-card::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--border-subtle), transparent);
    }

    .kpi-label {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }

    .kpi-val {
      font-size: 1.8rem;
      font-weight: 700;
      margin: 0.4rem 0 0.2rem 0;
      font-family: var(--font-mono);
      letter-spacing: -0.02em;
    }

    .kpi-sub {
      font-size: 0.75rem;
      color: var(--text-dim);
    }

    /* Main Workspace Layout */
    .workspace-grid {
      display: grid;
      grid-template-columns: 340px 1fr;
      gap: 1.5rem;
      align-items: start;
    }

    @media (max-width: 1080px) {
      .workspace-grid {
        grid-template-columns: 1fr;
      }
    }

    /* Left Panel: Runs Explorer */
    .panel {
      background: var(--bg-surface);
      backdrop-filter: blur(12px);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .panel-header {
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .panel-title {
      font-size: 0.95rem;
      font-weight: 700;
      letter-spacing: 0.02em;
    }

    .search-box {
      padding: 0.75rem 1.25rem;
      border-bottom: 1px solid var(--border-subtle);
    }

    .search-input {
      width: 100%;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--border-subtle);
      color: #fff;
      padding: 0.5rem 0.75rem;
      border-radius: 6px;
      font-size: 0.825rem;
      font-family: inherit;
    }

    .search-input:focus {
      outline: none;
      border-color: var(--cyan);
    }

    .runs-list {
      max-height: 680px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }

    .run-item {
      padding: 0.9rem 1.25rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      cursor: pointer;
      transition: all 0.15s ease;
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }

    .run-item:hover {
      background: var(--bg-surface-hover);
    }

    .run-item.active {
      background: rgba(0, 240, 255, 0.08);
      border-left: 3px solid var(--cyan);
    }

    .run-header-line {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .run-id {
      font-family: var(--font-mono);
      font-size: 0.85rem;
      font-weight: 600;
      color: #fff;
    }

    .phase-badge {
      font-size: 0.68rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
    }

    .phase-clean_terminated { background: rgba(16, 185, 129, 0.15); color: var(--emerald); border: 1px solid rgba(16, 185, 129, 0.3); }
    .phase-in_progress { background: rgba(0, 240, 255, 0.15); color: var(--cyan); border: 1px solid rgba(0, 240, 255, 0.3); }
    .phase-evaluating { background: rgba(245, 158, 11, 0.15); color: var(--amber); border: 1px solid rgba(245, 158, 11, 0.3); }
    .phase-quarantined { background: rgba(244, 63, 94, 0.15); color: var(--rose); border: 1px solid rgba(244, 63, 94, 0.3); }
    .phase-created { background: rgba(148, 163, 184, 0.15); color: var(--text-muted); border: 1px solid rgba(148, 163, 184, 0.3); }

    .run-subline {
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
      color: var(--text-dim);
    }

    /* Right Main Deck */
    .deck {
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }

    /* Tabs Bar */
    .tabs-bar {
      display: flex;
      gap: 0.5rem;
      border-bottom: 1px solid var(--border-subtle);
      padding-bottom: 0.5rem;
    }

    .tab-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 0.55rem 1rem;
      font-size: 0.85rem;
      font-weight: 600;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
      font-family: inherit;
    }

    .tab-btn:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.04);
    }

    .tab-btn.active {
      color: var(--cyan);
      background: rgba(0, 240, 255, 0.1);
      box-shadow: inset 0 0 0 1px rgba(0, 240, 255, 0.3);
    }

    /* Tab Contents */
    .tab-pane {
      display: none;
      flex-direction: column;
      gap: 1.25rem;
    }

    .tab-pane.active {
      display: flex;
    }

    /* Visual Progression Stepper */
    .stepper-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      padding: 1.5rem;
    }

    .stepper-title {
      font-size: 0.85rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 1.5rem;
      display: flex;
      justify-content: space-between;
    }

    .stepper {
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: relative;
    }

    .stepper::before {
      content: "";
      position: absolute;
      top: 18px;
      left: 30px;
      right: 30px;
      height: 2px;
      background: rgba(255, 255, 255, 0.1);
      z-index: 1;
    }

    .step-node {
      position: relative;
      z-index: 2;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.5rem;
    }

    .step-circle {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      background: var(--bg-base);
      border: 2px solid var(--border-subtle);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.8rem;
      font-weight: 700;
      color: var(--text-dim);
      transition: all 0.2s ease;
    }

    .step-node.completed .step-circle {
      border-color: var(--emerald);
      background: rgba(16, 185, 129, 0.15);
      color: var(--emerald);
      box-shadow: 0 0 10px var(--emerald-glow);
    }

    .step-node.active .step-circle {
      border-color: var(--cyan);
      background: rgba(0, 240, 255, 0.15);
      color: var(--cyan);
      box-shadow: 0 0 15px var(--cyan-glow);
      animation: pulse 1.5s infinite ease-in-out;
    }

    .step-node.quarantined .step-circle {
      border-color: var(--rose);
      background: rgba(244, 63, 94, 0.15);
      color: var(--rose);
    }

    .step-label {
      font-size: 0.72rem;
      font-weight: 600;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .step-node.completed .step-label { color: var(--emerald); }
    .step-node.active .step-label { color: var(--cyan); }

    /* Metadata Deck */
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1rem;
    }

    .meta-item {
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 0.85rem;
    }

    .meta-label {
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--text-dim);
      letter-spacing: 0.05em;
    }

    .meta-value {
      font-family: var(--font-mono);
      font-size: 0.85rem;
      font-weight: 600;
      color: #fff;
      margin-top: 0.3rem;
      word-break: break-all;
    }

    /* Tournament Table */
    .tournament-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
    }

    .tournament-table th {
      text-align: left;
      padding: 0.75rem 1rem;
      background: rgba(0, 0, 0, 0.35);
      color: var(--text-muted);
      font-size: 0.725rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-bottom: 1px solid var(--border-subtle);
    }

    .tournament-table td {
      padding: 0.85rem 1rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      vertical-align: middle;
    }

    .tournament-table tr:hover td {
      background: rgba(255, 255, 255, 0.02);
    }

    .pareto-tag {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.7rem;
      font-weight: 700;
      background: rgba(16, 185, 129, 0.15);
      color: var(--emerald);
      border: 1px solid rgba(16, 185, 129, 0.3);
      padding: 0.15rem 0.5rem;
      border-radius: 9999px;
    }

    .winner-tag {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.7rem;
      font-weight: 700;
      background: rgba(168, 85, 247, 0.18);
      color: var(--violet);
      border: 1px solid rgba(168, 85, 247, 0.4);
      padding: 0.15rem 0.5rem;
      border-radius: 9999px;
    }

    /* Harvest Approval Deck */
    .harvest-deck {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }

    .gate-list {
      display: flex;
      flex-direction: column;
      gap: 0.65rem;
    }

    .gate-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1rem;
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
    }

    .gate-info {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-size: 0.85rem;
      font-weight: 600;
    }

    .gate-status-pill {
      font-size: 0.72rem;
      font-weight: 700;
      padding: 0.2rem 0.55rem;
      border-radius: 4px;
    }

    .gate-pass { background: rgba(16, 185, 129, 0.15); color: var(--emerald); border: 1px solid rgba(16, 185, 129, 0.3); }
    .gate-fail { background: rgba(244, 63, 94, 0.15); color: var(--rose); border: 1px solid rgba(244, 63, 94, 0.3); }

    .canonical-box {
      background: #000;
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 1rem;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      color: var(--cyan);
      word-break: break-all;
      line-height: 1.5;
    }

    /* Charts Deck */
    .charts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
      gap: 1.25rem;
    }

    .chart-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.85rem;
    }

    .chart-title {
      font-size: 0.825rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }

    svg.chart-svg {
      width: 100%;
      height: 200px;
    }

    /* Modal */
    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      z-index: 100;
      align-items: center;
      justify-content: center;
    }

    .modal-overlay.open {
      display: flex;
    }

    .modal {
      background: #0f172a;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      width: 90%;
      max-width: 540px;
      padding: 1.75rem;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }

    .modal-title {
      font-size: 1.1rem;
      font-weight: 700;
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }

    .form-label {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    .form-input {
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--border-subtle);
      color: #fff;
      padding: 0.6rem 0.85rem;
      border-radius: 6px;
      font-size: 0.85rem;
      font-family: inherit;
    }

    .form-input:focus {
      outline: none;
      border-color: var(--cyan);
    }
  </style>
</head>
<body>

  <!-- Top Navigation -->
  <header>
    <div class="brand">
      <div class="brand-logo">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
          <polyline points="2 17 12 22 22 17"></polyline>
          <polyline points="2 12 12 17 22 12"></polyline>
        </svg>
      </div>
      <div>
        <div class="brand-title">OUTSIDE ORCHESTRATOR</div>
      </div>
      <span class="brand-badge">Tier 1 Edge / Control Plane</span>
    </div>

    <div class="header-controls">
      <div class="status-pill">
        <span class="status-dot"></span>
        <span id="nodeHostname">srv719637</span> &bull; <span id="nodeUptime">--s</span>
      </div>

      <button id="pollToggleBtn" class="btn" onclick="togglePolling()">
        <span style="color: var(--cyan);">●</span> Live (3s)
      </button>

      <button id="refreshBtn" class="btn" onclick="refreshAll()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
        </svg>
        Refresh
      </button>

      <button id="pruneBtn" class="btn" onclick="triggerTailscalePrune()" title="Deauthorizes stale ephemeral sandbox nodes and verifies absence">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
        Prune Nodes
      </button>

      <button id="newRunBtn" class="btn btn-primary" onclick="openNewRunModal()">
        + New Run
      </button>
    </div>
  </header>

  <!-- Main Content -->
  <main>

    <!-- Top KPI Cards -->
    <div class="kpi-row">
      <div class="kpi-card">
        <span class="kpi-label">Total Factory Runs</span>
        <div class="kpi-val" id="kpiTotalRuns">--</div>
        <span class="kpi-sub" id="kpiActiveRuns">-- active in progress</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Phase Transitions</span>
        <div class="kpi-val" id="kpiTransitions" style="color: var(--cyan);">--</div>
        <span class="kpi-sub">Total CAS transitions recorded</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Tournament Evaluations</span>
        <div class="kpi-val" id="kpiTournamentEvals" style="color: var(--violet);">--</div>
        <span class="kpi-sub">Pareto frontiers arbitrated</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Watchdog Heartbeats</span>
        <div class="kpi-val" id="kpiWatchdog" style="color: var(--emerald);">--</div>
        <span class="kpi-sub">Systemd liveness pings sent</span>
      </div>
    </div>

    <!-- Workspace Grid -->
    <div class="workspace-grid">
      
      <!-- Left: Runs Explorer -->
      <div class="panel">
        <div class="panel-header">
          <span class="panel-title">Runs Explorer</span>
          <span id="runsCountBadge" style="font-size: 0.75rem; color: var(--text-dim); font-family: var(--font-mono);">0 runs</span>
        </div>
        <div class="search-box">
          <input type="text" id="runSearchInput" class="search-input" placeholder="Filter by run or tenant ID..." oninput="filterRuns()">
        </div>
        <div id="runsList" class="runs-list">
          <!-- Populated by JS -->
          <div style="padding: 2rem; text-align: center; color: var(--text-dim);">Loading runs...</div>
        </div>
      </div>

      <!-- Right: Main Command Deck -->
      <div class="deck">
        
        <!-- Tabs Bar -->
        <div class="tabs-bar">
          <button class="tab-btn active" onclick="selectTab('progression')">Run Progression</button>
          <button class="tab-btn" onclick="selectTab('tournament')">Tournament & Pareto Frontier</button>
          <button class="tab-btn" onclick="selectTab('harvest')">1-Click Harvest Review</button>
          <button class="tab-btn" onclick="selectTab('telemetry')">Prometheus Telemetry</button>
        </div>

        <!-- TAB 1: RUN PROGRESSION -->
        <div id="tab-progression" class="tab-pane active">
          
          <!-- Visual Stepper Pipeline -->
          <div class="stepper-card">
            <div class="stepper-title">
              <span>Phase Progression Pipeline</span>
              <span id="runStateVersion" style="font-family: var(--font-mono); color: var(--cyan);">State Version: --</span>
            </div>
            
            <div class="stepper" id="progressionStepper">
              <div class="step-node" data-phase="created">
                <div class="step-circle">1</div>
                <span class="step-label">Created</span>
              </div>
              <div class="step-node" data-phase="provisioning">
                <div class="step-circle">2</div>
                <span class="step-label">Provision</span>
              </div>
              <div class="step-node" data-phase="delegated">
                <div class="step-circle">3</div>
                <span class="step-label">Delegated</span>
              </div>
              <div class="step-node" data-phase="in_progress">
                <div class="step-circle">4</div>
                <span class="step-label">Execution</span>
              </div>
              <div class="step-node" data-phase="evaluating">
                <div class="step-circle">5</div>
                <span class="step-label">Evaluating</span>
              </div>
              <div class="step-node" data-phase="clean_terminated">
                <div class="step-circle">6</div>
                <span class="step-label">Clean Term</span>
              </div>
            </div>
          </div>

          <!-- Action Banner / Dispatch Control for Selected Run -->
          <div id="progressionActionBanner" style="margin-top: 1rem; margin-bottom: 1rem; display: none;">
            <div style="background: rgba(14, 165, 233, 0.08); border: 1px solid rgba(14, 165, 233, 0.3); border-radius: 8px; padding: 1rem 1.25rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem;">
              <div>
                <div style="font-weight: 600; font-size: 0.95rem; color: #fff;">Run Admitted — Ready for Sandbox Dispatch</div>
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.2rem;">
                  Provision ephemeral exe.dev VM, apply Tailscale isolation, and start execution (Contract §6.3, §6.5).
                </div>
              </div>
              <button id="btnDispatchSandbox" class="btn btn-primary" onclick="dispatchSelectedRun()" style="display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 1.2rem; font-weight: 600; white-space: nowrap;">
                <span>🚀 Dispatch Live Sandbox</span>
              </button>
            </div>
          </div>

          <!-- Human User Prompt Card -->
          <div id="humanPromptCard" style="background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.25rem; margin-top: 1rem; margin-bottom: 1rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
              <div style="display: flex; align-items: center; gap: 0.6rem;">
                <span style="font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; color: var(--cyan);">Human User Prompt & Task Specification</span>
                <span id="executionKindBadge" style="font-size: 0.7rem; padding: 0.15rem 0.5rem; border-radius: 4px; font-weight: 700; font-family: var(--font-mono); display: none;"></span>
              </div>
              <span id="promptIntentBadge" style="font-size: 0.7rem; background: rgba(255,255,255,0.06); padding: 0.2rem 0.5rem; border-radius: 4px; color: var(--text-dim); font-family: var(--font-mono);">intent: --</span>
            </div>
            <div id="metaUserPrompt" style="font-family: var(--font-mono); font-size: 0.85rem; color: #fff; white-space: pre-wrap; background: rgba(0,0,0,0.25); padding: 0.75rem; border-radius: 6px; border: 1px solid rgba(255,255,255,0.05); max-height: 140px; overflow-y: auto;">
              --
            </div>
            <div style="display: flex; flex-wrap: wrap; gap: 1.5rem; margin-top: 0.6rem; font-size: 0.75rem; color: var(--text-muted);">
              <div><strong style="color: var(--text-dim);">Acceptance Criteria:</strong> <span id="metaAcceptance">--</span></div>
              <div><strong style="color: var(--text-dim);">Max Fix Loops:</strong> <span id="metaFixLoops" style="color: var(--cyan); font-family: var(--font-mono);">3 (default)</span></div>
              <div id="metaDetCmdContainer" style="display: none;"><strong style="color: var(--text-dim);">Deterministic Gate:</strong> <span id="metaDeterministicCommand" style="color: var(--emerald); font-family: var(--font-mono);">--</span></div>
            </div>
          </div>

          <!-- Run Metadata Grid -->
          <div class="meta-grid">
            <div class="meta-item">
              <div class="meta-label">Run ID</div>
              <div class="meta-value" id="metaRunId">--</div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Tenant ID</div>
              <div class="meta-value" id="metaTenantId">--</div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Policy Version</div>
              <div class="meta-value" id="metaPolicyVer">--</div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Parent Git SHA</div>
              <div class="meta-value" id="metaParentSha">--</div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Max Cost Budget</div>
              <div class="meta-value" id="metaBudgetCost">--</div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Envelope SHA256</div>
              <div class="meta-value" id="metaEnvelopeHash">--</div>
            </div>
          </div>

        </div>

        <!-- TAB 2: TOURNAMENT & PARETO ARBITRATION -->
        <div id="tab-tournament" class="tab-pane">
          <div class="panel">
            <div class="panel-header">
              <div>
                <span class="panel-title">Multi-Criteria Pareto Tournament Arms</span>
                <div style="font-size: 0.75rem; color: var(--text-dim); margin-top: 0.2rem;">
                  Host-side multi-objective non-dominance arbitration across (Cost, Latency, Quality, Churn)
                </div>
              </div>

              <div style="display: flex; gap: 0.75rem; align-items: center;">
                <select id="tournStrategySelect" class="form-input" style="padding: 0.35rem 0.65rem; font-size: 0.8rem;" onchange="evaluateTournamentStrategy()">
                  <option value="lowest_cost">Strategy: Lowest Cost</option>
                  <option value="fastest_latency">Strategy: Fastest Latency</option>
                  <option value="highest_coverage">Strategy: Highest Code Coverage</option>
                  <option value="pareto_optimal" selected>Strategy: Pareto Optimal Frontier</option>
                  <option value="weighted_composite">Strategy: Weighted Composite</option>
                </select>

                <button class="btn btn-primary" onclick="autoSelectParetoWinner()">
                  ⚡ Auto-Select Pareto Winner
                </button>
              </div>
            </div>

            <div style="overflow-x: auto;">
              <table class="tournament-table">
                <thead>
                  <tr>
                    <th>Arm ID</th>
                    <th>Model</th>
                    <th>Status</th>
                    <th>Tests</th>
                    <th>Coverage</th>
                    <th>Cost</th>
                    <th>Latency</th>
                    <th>Quality</th>
                    <th>Churn</th>
                    <th>Frontier / Dominance</th>
                    <th>Utility</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody id="tournamentTableBody">
                  <tr><td colspan="12" style="text-align: center; color: var(--text-dim); padding: 2rem;">Select a run with tournament arms</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- TAB 3: 1-CLICK HARVEST REVIEW -->
        <div id="tab-harvest" class="tab-pane">
          <div class="harvest-deck">
            <div>
              <h3 style="font-size: 1.1rem; font-weight: 700;">1-Click Ed25519 Harvest Gate & Authorization</h3>
              <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">
                Enforces strict 5-gate zero-trust verification before generating canonical Git ref and attestation (Contract §4, §6.8, §9 & §10 AC 10).
              </p>
            </div>

            <!-- Multi-Gate Verification Status -->
            <div class="gate-list" id="harvestGateList">
              <div class="gate-item">
                <div class="gate-info">
                  <span id="gateIconClean">⏳</span>
                  <span>1. CLEAN_TERMINATED Verification (12-predicate proof)</span>
                </div>
                <span id="gateBadgeClean" class="gate-status-pill gate-fail">Pending</span>
              </div>
              <div class="gate-item">
                <div class="gate-info">
                  <span id="gateIconErg">⏳</span>
                  <span>2. Effect Reconciliation Gate (Zero undeclared file touches)</span>
                </div>
                <span id="gateBadgeErg" class="gate-status-pill gate-fail">Pending</span>
              </div>
              <div class="gate-item">
                <div class="gate-info">
                  <span id="gateIconTest">⏳</span>
                  <span>3. Frozen Acceptance Test Suite (Exit code 0 & hash verified)</span>
                </div>
                <span id="gateBadgeTest" class="gate-status-pill gate-fail">Pending</span>
              </div>
              <div class="gate-item">
                <div class="gate-info">
                  <span id="gateIconAdvisory">⏳</span>
                  <span>4. Advisory Trace Output (Trace manifest hash verified)</span>
                </div>
                <span id="gateBadgeAdvisory" class="gate-status-pill gate-fail">Pending</span>
              </div>
              <div class="gate-item">
                <div class="gate-info">
                  <span id="gateIconWinner">⏳</span>
                  <span>5. Deliberate Tournament Winner Selection</span>
                </div>
                <span id="gateBadgeWinner" class="gate-status-pill gate-fail">Pending</span>
              </div>
            </div>

            <!-- Canonical Tuple Message -->
            <div>
              <span class="kpi-label">Canonical Cryptographic Message Tuple</span>
              <div class="canonical-box" id="canonicalTuplePreview">
                (Select a completed run to generate harvest proposal)
              </div>
            </div>

            <!-- 1-Click Approval Button Deck -->
            <div style="display: flex; gap: 1rem; align-items: center;">
              <button id="quickApproveBtn" class="btn btn-emerald" style="padding: 0.75rem 1.5rem; font-size: 0.95rem;" onclick="executeQuickHarvest()">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
                1-Click Approve & Sign Harvest (Ed25519)
              </button>
              <span id="harvestResultMsg" style="font-size: 0.85rem; font-family: var(--font-mono);"></span>
            </div>
          </div>
        </div>

        <!-- TAB 4: PROMETHEUS TELEMETRY -->
        <div id="tab-telemetry" class="tab-pane">
          <div class="charts-grid">
            <div class="chart-card">
              <span class="chart-title">Run Throughput by Phase</span>
              <svg id="chartPhases" class="chart-svg"></svg>
            </div>
            <div class="chart-card">
              <span class="chart-title">Inference & Tournament Metrics</span>
              <svg id="chartMetrics" class="chart-svg"></svg>
            </div>
          </div>
        </div>

      </div>

    </div>

  </main>

  <!-- New Run Modal -->
  <div id="newRunModal" class="modal-overlay">
    <div class="modal">
      <div class="modal-title">Dispatch New Factory Run</div>
      <div class="form-group">
        <label class="form-label">Tenant ID</label>
        <input type="text" id="inputTenantId" class="form-input" value="tenant-production">
      </div>
      <div class="form-group">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem;">
          <label class="form-label" style="margin-bottom: 0;">Human User Prompt & Instructions</label>
          <div style="display: flex; gap: 0.35rem;">
            <button type="button" class="btn" style="padding: 0.15rem 0.4rem; font-size: 0.7rem;" onclick="applyPromptTemplate('four_line')">4-Line SSSF</button>
            <button type="button" class="btn" style="padding: 0.15rem 0.4rem; font-size: 0.7rem;" onclick="applyPromptTemplate('feature')">Feature</button>
            <button type="button" class="btn" style="padding: 0.15rem 0.4rem; font-size: 0.7rem;" onclick="applyPromptTemplate('bugfix')">Bug Fix</button>
            <button type="button" class="btn" style="padding: 0.15rem 0.4rem; font-size: 0.7rem;" onclick="applyPromptTemplate('scout')">Scout</button>
          </div>
        </div>
        <textarea id="inputUserPrompt" class="form-input" rows="4" style="font-family: var(--font-mono); font-size: 0.8rem; resize: vertical;" placeholder="Enter task instructions (e.g. Add a GET /api/tags endpoint...)"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Execution Kind</label>
        <select id="inputExecutionKind" class="form-input" onchange="toggleDetCmdInput()">
          <option value="agent" selected>Agent Driven (AI Inference & Model Synthesis)</option>
          <option value="code">Code Gate (Deterministic Subprocess — $0.00)</option>
        </select>
      </div>
      <div class="form-group" id="groupDeterministicCommand" style="display: none;">
        <label class="form-label">Deterministic Command (SSSF Subprocess Pattern)</label>
        <input type="text" id="inputDeterministicCommand" class="form-input" value="npm test" placeholder="e.g. npm test, bun test, pytest">
      </div>
      <div class="form-group">
        <label class="form-label">Parent Git SHA</label>
        <input type="text" id="inputParentSha" class="form-input" value="cb48638000000000000000000000000000000000">
      </div>
      <div class="form-group">
        <label class="form-label">Max Cost Budget (cents)</label>
        <input type="number" id="inputMaxCost" class="form-input" value="1000">
      </div>
      <div class="form-group">
        <label class="form-label">Max Fix Loops (Bounded Correction)</label>
        <input type="number" id="inputMaxFixLoops" class="form-input" value="3" min="1" max="10">
      </div>
      <div class="form-group">
        <label style="display: flex; align-items: center; gap: 0.6rem; cursor: pointer; font-size: 0.85rem; color: var(--text-muted); margin-top: 0.25rem;">
          <input type="checkbox" id="inputAutoDispatch" checked style="accent-color: var(--cyan); width: 16px; height: 16px; cursor: pointer;">
          <span style="color: #fff;">Immediately dispatch execution to Tier 2 sandbox VM</span>
        </label>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 0.75rem;">
        <button class="btn" onclick="closeNewRunModal()">Cancel</button>
        <button class="btn" onclick="submitNewRun()">Admit & Dispatch</button>
        <button class="btn btn-emerald" onclick="submitLiveE2eRun()">🚀 Live Sandbox & Auto-PR</button>
      </div>
    </div>
  </div>

  <script>
    // Global State
    let allRuns = [];
    let selectedRunId = null;
    let isPolling = true;
    let pollInterval = null;

    // Phase Order
    const PHASES = ["created", "provisioning", "delegated", "in_progress", "evaluating", "clean_terminated"];

    // Initialize
    window.addEventListener("DOMContentLoaded", () => {
      refreshAll();
      startPolling();
    });

    function togglePolling() {
      isPolling = !isPolling;
      const btn = document.getElementById("pollToggleBtn");
      if (isPolling) {
        btn.innerHTML = '<span style="color: var(--cyan);">●</span> Live (3s)';
        startPolling();
      } else {
        btn.innerHTML = '<span style="color: var(--text-dim);">○</span> Paused';
        clearInterval(pollInterval);
      }
    }

    function startPolling() {
      clearInterval(pollInterval);
      pollInterval = setInterval(() => {
        if (isPolling) {
          refreshRunsSilent();
          refreshHealthAndMetrics();
        }
      }, 3000);
    }

    async function refreshAll() {
      await Promise.all([
        refreshHealthAndMetrics(),
        fetchRuns()
      ]);
    }

    async function refreshHealthAndMetrics() {
      try {
        const [healthRes, metricsRes] = await Promise.all([
          fetch("/health"),
          fetch("/metrics")
        ]);

        if (healthRes.ok) {
          const health = await healthRes.json();
          document.getElementById("nodeHostname").textContent = health.node || "srv719637";
          document.getElementById("nodeUptime").textContent = Math.round(health.uptime || 0) + "s";
        }

        if (metricsRes.ok) {
          const metricsText = await metricsRes.text();
          parseAndRenderMetrics(metricsText);
        }
      } catch (err) {
        console.error("Health/Metrics refresh failed:", err);
      }
    }

    function parseAndRenderMetrics(text) {
      let transitions = 0;
      let tournamentEvals = 0;
      let heartbeats = 0;

      const lines = text.split("\\n");
      for (const line of lines) {
        if (line.startsWith("outside_orchestrator_phase_transitions_total")) {
          const m = line.match(/\\s+(\\d+)/);
          if (m) transitions += parseInt(m[1], 10);
        } else if (line.startsWith("outside_orchestrator_tournament_evaluations_total")) {
          const m = line.match(/\\s+(\\d+)/);
          if (m) tournamentEvals += parseInt(m[1], 10);
        } else if (line.startsWith("outside_orchestrator_watchdog_heartbeats_total")) {
          const m = line.match(/\\s+(\\d+)/);
          if (m) heartbeats += parseInt(m[1], 10);
        }
      }

      document.getElementById("kpiTransitions").textContent = transitions || 0;
      document.getElementById("kpiTournamentEvals").textContent = tournamentEvals || 0;
      document.getElementById("kpiWatchdog").textContent = heartbeats || 0;
    }

    async function fetchRuns() {
      try {
        const res = await fetch("/v1/runs");
        if (!res.ok) return;
        allRuns = await res.json();
        
        document.getElementById("kpiTotalRuns").textContent = allRuns.length;
        const activeCount = allRuns.filter(r => !["clean_terminated", "quarantined", "failed"].includes(r.phase)).length;
        document.getElementById("kpiActiveRuns").textContent = \`\${activeCount} active in progress\`;
        document.getElementById("runsCountBadge").textContent = \`\${allRuns.length} runs\`;

        renderRunsList();

        if (!selectedRunId && allRuns.length > 0) {
          selectRun(allRuns[0].id);
        } else if (selectedRunId) {
          // Refresh details for active selected run
          loadRunDetails(selectedRunId);
        }
      } catch (err) {
        console.error("Fetch runs failed:", err);
      }
    }

    async function refreshRunsSilent() {
      try {
        const res = await fetch("/v1/runs");
        if (!res.ok) return;
        allRuns = await res.json();
        renderRunsList();
        if (selectedRunId) {
          loadRunDetails(selectedRunId);
        }
      } catch (err) {
        // silent
      }
    }

    function renderRunsList() {
      const container = document.getElementById("runsList");
      const search = document.getElementById("runSearchInput").value.toLowerCase();
      const filtered = allRuns.filter(r => 
        r.id.toLowerCase().includes(search) || 
        r.tenant_id.toLowerCase().includes(search) ||
        (r.envelope?.user_prompt && r.envelope.user_prompt.toLowerCase().includes(search)) ||
        (r.envelope?.intent && r.envelope.intent.toLowerCase().includes(search))
      );

      if (filtered.length === 0) {
        container.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--text-dim);">No runs found</div>';
        return;
      }

      container.innerHTML = filtered.map(r => {
        const promptSnippet = (r.envelope?.user_prompt || (r.envelope?.intent !== 'execute' ? r.envelope?.intent : '') || '').split('\\n')[0].slice(0, 36);
        const isCode = r.envelope?.execution_kind === "code";
        const kindTag = isCode
          ? '<span style="font-size: 0.65rem; color: var(--emerald); font-weight: 700; margin-left: 0.35rem; font-family: var(--font-mono);">[CODE]</span>'
          : '<span style="font-size: 0.65rem; color: var(--violet); font-weight: 700; margin-left: 0.35rem; font-family: var(--font-mono);">[AGENT]</span>';
        return \`
        <div class="run-item \${r.id === selectedRunId ? 'active' : ''}" onclick="selectRun('\${r.id}')">
          <div class="run-header-line">
            <span class="run-id">\${r.id.slice(0, 13)}...\${kindTag}</span>
            <span class="phase-badge phase-\${r.phase}">\${r.phase}</span>
          </div>
          \${promptSnippet ? \`<div style="font-size: 0.72rem; color: var(--cyan); margin-top: 0.25rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono);">\${promptSnippet}</div>\` : ''}
          <div class="run-subline" style="margin-top: 0.25rem;">
            <span>\${r.tenant_id}</span>
            <span>v\${r.state_version}</span>
          </div>
        </div>
        \`;
      }).join("");
    }

    function filterRuns() {
      renderRunsList();
    }

    async function selectRun(runId) {
      selectedRunId = runId;
      renderRunsList();
      await loadRunDetails(runId);
    }

    async function loadRunDetails(runId) {
      const run = allRuns.find(r => r.id === runId);
      if (!run) return;

      // Update Progression Stepper
      updateStepper(run.phase);

      // Update Human User Prompt Card
      const promptText = run.envelope?.user_prompt || (run.envelope?.intent !== "execute" ? run.envelope?.intent : null) || "(No human prompt specified; default execution intent)";
      document.getElementById("metaUserPrompt").textContent = promptText;
      document.getElementById("promptIntentBadge").textContent = \`intent: \${run.envelope?.intent || "execute"}\`;
      const crit = run.envelope?.acceptance_criteria;
      document.getElementById("metaAcceptance").textContent = Array.isArray(crit) ? crit.join("; ") : (crit || "Valid phase result");
      const fixLoops = run.envelope?.max_fix_loops ?? 3;
      document.getElementById("metaFixLoops").textContent = \`\${fixLoops} bounded\`;

      const execKind = run.envelope?.execution_kind || (run.phase === "test" ? "code" : "agent");
      const kindBadge = document.getElementById("executionKindBadge");
      if (kindBadge) {
        kindBadge.style.display = "inline-block";
        if (execKind === "code") {
          kindBadge.style.background = "rgba(16, 185, 129, 0.15)";
          kindBadge.style.color = "var(--emerald)";
          kindBadge.style.border = "1px solid rgba(16, 185, 129, 0.3)";
          kindBadge.textContent = "[CODE GATE: $0.00]";
        } else {
          kindBadge.style.background = "rgba(168, 85, 247, 0.15)";
          kindBadge.style.color = "var(--violet)";
          kindBadge.style.border = "1px solid rgba(168, 85, 247, 0.3)";
          kindBadge.textContent = "[AGENT DRIVEN]";
        }
      }

      const detCmd = run.envelope?.deterministic_command;
      const detContainer = document.getElementById("metaDetCmdContainer");
      const detCmdSpan = document.getElementById("metaDeterministicCommand");
      if (detContainer && detCmdSpan) {
        if (detCmd || execKind === "code") {
          detContainer.style.display = "block";
          detCmdSpan.textContent = detCmd || "npm test";
        } else {
          detContainer.style.display = "none";
        }
      }

      // Update Metadata Deck
      document.getElementById("metaRunId").textContent = run.id;
      document.getElementById("metaTenantId").textContent = run.tenant_id;
      document.getElementById("metaPolicyVer").textContent = run.policy_version || "v2.0";
      document.getElementById("metaParentSha").textContent = (run.parent_git_sha || "none").slice(0, 16) + "...";
      document.getElementById("metaBudgetCost").textContent = \`\${run.budget?.max_cost_cents || 0}¢\`;
      document.getElementById("metaEnvelopeHash").textContent = (run.envelope?.task_envelope_hash || run.task_envelope_hash || "none").slice(0, 16) + "...";
      document.getElementById("runStateVersion").textContent = \`State Version: v\${run.state_version}\`;

      // Action Banner for Sandbox Dispatch
      const banner = document.getElementById("progressionActionBanner");
      if (banner) {
        banner.style.display = run.phase === "created" ? "block" : "none";
      }

      // Load Tournament Arms
      loadTournamentArms(runId);

      // Load Harvest Proposal
      loadHarvestProposal(runId);
    }

    function updateStepper(currentPhase) {
      const stepper = document.getElementById("progressionStepper");
      const nodes = stepper.querySelectorAll(".step-node");
      const currentIndex = PHASES.indexOf(currentPhase);

      nodes.forEach((node, i) => {
        node.classList.remove("completed", "active", "quarantined");
        if (currentPhase === "quarantined" || currentPhase === "failed") {
          node.classList.add("quarantined");
        } else if (i < currentIndex) {
          node.classList.add("completed");
        } else if (i === currentIndex) {
          node.classList.add("active");
        }
      });
    }

    async function loadTournamentArms(runId) {
      try {
        const res = await fetch(\`/v1/runs/\${runId}/tournament\`);
        if (!res.ok) return;
        const data = await res.json();
        const tbody = document.getElementById("tournamentTableBody");

        if (!data.arms || data.arms.length === 0) {
          tbody.innerHTML = '<tr><td colspan="12" style="text-align: center; color: var(--text-dim); padding: 2rem;">No tournament arms registered for this run</td></tr>';
          return;
        }

        tbody.innerHTML = data.evaluations.map(ev => {
          const arm = ev.arm;
          const isWinner = arm.selection_status === "winner";
          const isPareto = ev.isParetoOptimal;
          const detTests = arm.metadata?.deterministic_tests || arm.metadata?.deterministicTests;
          const passedCount = detTests ? (detTests.passed_count ?? detTests.passedCount ?? 0) : null;
          const totalCount = detTests ? (detTests.total_count ?? detTests.totalCount ?? 0) : null;
          const failedCount = detTests ? (detTests.failed_count ?? detTests.failedCount ?? 0) : null;
          const coveragePct = typeof ev.metrics?.coveragePct === "number"
            ? ev.metrics.coveragePct
            : (typeof arm.metadata?.coverage_pct === "number" ? arm.metadata.coverage_pct : 100);

          let testsHtml = '<span style="color: var(--text-dim); font-size: 0.75rem;">--</span>';
          if (detTests) {
            if (detTests.exit_code === 0 && failedCount === 0) {
              testsHtml = \`<span class="pareto-tag" style="background: rgba(16, 185, 129, 0.12); color: var(--emerald); border-color: rgba(16, 185, 129, 0.3);">✔ \${passedCount}/\${totalCount}</span>\`;
            } else {
              testsHtml = \`<span class="pareto-tag" style="background: rgba(244, 63, 94, 0.15); color: var(--rose); border-color: rgba(244, 63, 94, 0.3);">✖ \${failedCount} fail</span>\`;
            }
          } else if (arm.metadata?.tests_passed === true) {
            testsHtml = '<span style="color: var(--emerald); font-weight: 600;">✔ pass</span>';
          } else if (arm.metadata?.tests_passed === false) {
            testsHtml = '<span style="color: var(--rose); font-weight: 600;">✖ fail</span>';
          }

          const covColor = coveragePct >= 80 ? 'var(--emerald)' : (coveragePct >= 50 ? 'var(--amber)' : 'var(--rose)');
          const covHtml = \`<span style="font-family: var(--font-mono); font-weight: 600; color: \${covColor};">\${coveragePct.toFixed(1)}%</span>\`;

          return \`
            <tr>
              <td style="font-family: var(--font-mono); font-weight: 600;">\${arm.arm_id}</td>
              <td style="color: var(--text-muted);">\${arm.model_id || 'default'}</td>
              <td><span class="phase-badge phase-\${arm.status}">\${arm.status}</span></td>
              <td>\${testsHtml}</td>
              <td>\${covHtml}</td>
              <td style="font-family: var(--font-mono);">\${arm.cost_cents}¢</td>
              <td style="font-family: var(--font-mono);">\${arm.latency_ms}ms</td>
              <td>\${ev.metrics?.qualityScore || 95}%</td>
              <td>\${ev.metrics?.churnFiles || 1} files</td>
              <td>
                \${isWinner ? '<span class="winner-tag">★ WINNER</span>' : ''}
                \${isPareto ? '<span class="pareto-tag">✔ PARETO</span>' : \`<span style="color: var(--text-dim); font-size: 0.72rem;">Dominated by: [\${ev.dominatedBy.join(', ') || 'none'}]</span>\`}
              </td>
              <td style="font-family: var(--font-mono); font-weight: 700; color: var(--cyan);">\${ev.utilityScore}</td>
              <td>
                \${!isWinner ? \`
                  <button class="btn" style="padding: 0.25rem 0.6rem; font-size: 0.75rem;" onclick="selectArmWinner('\${arm.arm_id}')">
                    Select Winner
                  </button>
                \` : '<span style="color: var(--emerald); font-weight: 600; font-size: 0.8rem;">Selected</span>'}
              </td>
            </tr>
          \`;
        }).join("");
      } catch (err) {
        console.error("Load tournament arms failed:", err);
      }
    }

    async function evaluateTournamentStrategy() {
      if (!selectedRunId) return;
      const strategy = document.getElementById("tournStrategySelect").value;
      try {
        const res = await fetch(\`/v1/runs/\${selectedRunId}/tournament/evaluate\`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ strategy })
        });
        if (res.ok) {
          loadTournamentArms(selectedRunId);
        }
      } catch (err) {
        console.error("Strategy evaluation failed:", err);
      }
    }

    async function autoSelectParetoWinner() {
      if (!selectedRunId) return;
      try {
        const res = await fetch(\`/v1/runs/\${selectedRunId}/tournament/select\`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            winner_arm_id: "auto_pareto",
            rationale: "Operator UI 1-Click Pareto Frontier Selection",
            reviewer_identity: "human:operator@dashboard"
          })
        });
        const data = await res.json();
        if (res.ok) {
          loadTournamentArms(selectedRunId);
          loadHarvestProposal(selectedRunId);
        } else {
          alert("Auto-Pareto selection failed: " + (data.message || data.error));
        }
      } catch (err) {
        alert("Error executing auto_pareto: " + err.message);
      }
    }

    async function selectArmWinner(armId) {
      if (!selectedRunId) return;
      try {
        const res = await fetch(\`/v1/runs/\${selectedRunId}/tournament/select\`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            winner_arm_id: armId,
            rationale: \`Operator UI manual selection of arm '\${armId}'\`,
            reviewer_identity: "human:operator@dashboard"
          })
        });
        if (res.ok) {
          loadTournamentArms(selectedRunId);
          loadHarvestProposal(selectedRunId);
        }
      } catch (err) {
        alert("Error selecting winner: " + err.message);
      }
    }

    async function loadHarvestProposal(runId) {
      try {
        const res = await fetch(\`/v1/runs/\${runId}/harvest/proposal\`);
        const data = await res.json();
        
        if (res.ok) {
          const v = data.verification || {};
          setGateStatus("Clean", v.isCleanTerminated);
          setGateStatus("Erg", v.ergPassed);
          setGateStatus("Test", v.testGatePassed);
          setGateStatus("Advisory", v.advisoryOutputCollected);
          setGateStatus("Winner", v.tournamentReady);

          document.getElementById("canonicalTuplePreview").textContent = data.canonicalMessage || "(canonical message not ready)";

          // Check for open PR and render merge action
          try {
            const prRes = await fetch(\`/v1/runs/\${runId}/pr-status\`);
            if (prRes.ok) {
              const prData = await prRes.json();
              if (prData.pr_number) {
                const isMerged = prData.pull_request?.merged;
                const statusBadge = isMerged
                  ? '<span style="color: var(--emerald); font-weight: 600; font-size: 12px;">✔ Merged into main</span>'
                  : \`<button id="mergeDeployBtn" class="btn btn-emerald" style="padding: 4px 10px; font-size: 12px; font-weight: 600;" onclick="executeMergeAndDeploy('\${runId}', \${prData.pr_number})">🔀 Merge PR & Deploy to VPS</button>\`;
                const prDiv = document.createElement("div");
                prDiv.id = "harvestPrDeck";
                prDiv.style.cssText = "margin-top: 10px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;";
                prDiv.innerHTML = \`<a href="\${prData.pull_request?.htmlUrl || '#'}" target="_blank" style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;background:rgba(0,240,255,0.15);border:1px solid var(--cyan);border-radius:4px;color:var(--cyan);font-weight:600;text-decoration:none;font-size:12px;">🔗 PR #\${prData.pr_number} (\${prData.pull_request?.state || 'open'})</a> \${statusBadge}\`;
                const existing = document.getElementById("harvestPrDeck");
                if (existing) existing.remove();
                document.getElementById("canonicalTuplePreview").parentNode.appendChild(prDiv);
              }
            }
          } catch {
            // ignore
          }
        } else {
          setGateStatus("Clean", false);
          setGateStatus("Erg", false);
          setGateStatus("Test", false);
          setGateStatus("Advisory", false);
          setGateStatus("Winner", false);
          document.getElementById("canonicalTuplePreview").textContent = \`Proposal blocked: \${data.message || data.error}\`;
          const existing = document.getElementById("harvestPrDeck");
          if (existing) existing.remove();
        }
      } catch (err) {
        console.error("Load harvest proposal failed:", err);
      }
    }

    function setGateStatus(name, passed) {
      const icon = document.getElementById("gateIcon" + name);
      const badge = document.getElementById("gateBadge" + name);
      if (!icon || !badge) return;
      if (passed) {
        icon.textContent = "✔";
        badge.className = "gate-status-pill gate-pass";
        badge.textContent = "VERIFIED";
      } else {
        icon.textContent = "✖";
        badge.className = "gate-status-pill gate-fail";
        badge.textContent = "BLOCKED";
      }
    }

    async function executeQuickHarvest() {
      if (!selectedRunId) return;
      const msgElem = document.getElementById("harvestResultMsg");
      msgElem.style.color = "var(--cyan)";
      msgElem.textContent = "Signing with Ed25519 operator key...";

      try {
        const res = await fetch(\`/v1/runs/\${selectedRunId}/harvest/quick-approve\`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reviewer_identity: "human:operator@dashboard"
          })
        });

        const data = await res.json();
        if (res.ok && data.success) {
          msgElem.style.color = "var(--emerald)";
          let prHtml = "";
          if (data.pr_url) {
            prHtml = \`<div style="margin-top:8px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              <a href="\${data.pr_url}" target="_blank" style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;background:rgba(0,240,255,0.15);border:1px solid var(--cyan);border-radius:4px;color:var(--cyan);font-weight:600;text-decoration:none;font-size:12px;">🔗 Open GitHub Pull Request #\${data.pr_number || ''}</a>
              <button id="mergeDeployBtn" class="btn btn-emerald" style="padding: 4px 10px; font-size: 12px; font-weight: 600;" onclick="executeMergeAndDeploy('\${selectedRunId}', \${data.pr_number || 'null'})">🔀 Merge PR & Deploy to VPS</button>
            </div>\`;
          }
          msgElem.innerHTML = \`<div>✔ Harvest Approved & Committed!</div><div style="font-family:monospace;font-size:11px;color:var(--text-muted);margin-top:2px;">Ref: \${data.git_ref} &bull; Branch: \${data.branch || 'N/A'}</div>\${prHtml}\`;
          loadHarvestProposal(selectedRunId);
        } else {
          msgElem.style.color = "var(--rose)";
          msgElem.textContent = \`✖ Harvest failed: \${data.message || data.error}\`;
        }
      } catch (err) {
        msgElem.style.color = "var(--rose)";
        msgElem.textContent = \`✖ Error: \${err.message}\`;
      }
    }

    async function executeMergeAndDeploy(runId, prNum) {
      const activeRunId = runId || selectedRunId;
      if (!activeRunId) return;
      const btn = document.getElementById("mergeDeployBtn");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Merging & Deploying...";
      }
      try {
        const res = await fetch(\`/v1/runs/\${activeRunId}/merge-pr\`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pr_number: prNum, deploy: true })
        });
        const data = await res.json();
        if (res.ok && data.merged) {
          if (btn) {
            btn.textContent = \`✔ PR #\${data.prNumber || prNum} Merged & Deployed!\`;
            btn.style.background = "var(--emerald)";
          }
          alert(\`✔ Pull Request #\${data.prNumber || prNum} successfully merged!\\nCommit: \${data.mergeCommitSha || 'N/A'}\\nDeployment: \${data.deployment?.status || 'success'}\`);
          loadHarvestProposal(activeRunId);
        } else {
          if (btn) {
            btn.disabled = false;
            btn.textContent = "✖ Merge Failed - Retry";
          }
          alert(\`Merge failed: \${data.message || data.error}\`);
        }
      } catch (err) {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "✖ Error - Retry";
        }
        alert(\`Error executing merge & deploy: \${err.message}\`);
      }
    }

    function selectTab(tabId) {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
      
      const btn = Array.from(document.querySelectorAll(".tab-btn")).find(b => b.getAttribute("onclick").includes(tabId));
      if (btn) btn.classList.add("active");
      const pane = document.getElementById("tab-" + tabId);
      if (pane) pane.classList.add("active");

      if (tabId === "telemetry") {
        renderSvgCharts();
      }
    }

    function renderSvgCharts() {
      // Draw Phase Donut / Bar Chart
      const phaseSvg = document.getElementById("chartPhases");
      const counts = {};
      PHASES.forEach(p => counts[p] = 0);
      allRuns.forEach(r => { counts[r.phase] = (counts[r.phase] || 0) + 1; });

      const colors = {
        created: "#94a3b8",
        provisioning: "#f59e0b",
        delegated: "#a855f7",
        in_progress: "#00f0ff",
        evaluating: "#ec4899",
        clean_terminated: "#10b981"
      };

      const keys = Object.keys(counts);
      const maxVal = Math.max(...Object.values(counts), 1);
      const barWidth = 45;
      const gap = 20;

      phaseSvg.innerHTML = keys.map((k, i) => {
        const val = counts[k];
        const h = Math.round((val / maxVal) * 120);
        const x = 30 + i * (barWidth + gap);
        const y = 160 - h;
        return \`
          <rect x="\${x}" y="\${y}" width="\${barWidth}" height="\${h}" fill="\${colors[k]}" rx="4" opacity="0.85"></rect>
          <text x="\${x + barWidth/2}" y="\${y - 8}" fill="#fff" font-size="11" font-family="monospace" text-anchor="middle">\${val}</text>
          <text x="\${x + barWidth/2}" y="180" fill="#94a3b8" font-size="9" text-anchor="middle">\${k.slice(0, 5)}</text>
        \`;
      }).join("");

      // Draw Metrics Chart
      const metricsSvg = document.getElementById("chartMetrics");
      metricsSvg.innerHTML = \`
        <line x1="40" y1="20" x2="40" y2="160" stroke="rgba(255,255,255,0.1)"></line>
        <line x1="40" y1="160" x2="380" y2="160" stroke="rgba(255,255,255,0.1)"></line>
        <path d="M 50 140 Q 120 70, 200 90 T 360 40" fill="none" stroke="var(--cyan)" stroke-width="2.5"></path>
        <path d="M 50 150 Q 130 110, 210 130 T 360 80" fill="none" stroke="var(--violet)" stroke-width="2.5"></path>
        <circle cx="360" cy="40" r="4" fill="var(--cyan)"></circle>
        <circle cx="360" cy="80" r="4" fill="var(--violet)"></circle>
        <text x="50" y="25" fill="var(--cyan)" font-size="10" font-family="monospace">● Cost Trend</text>
        <text x="140" y="25" fill="var(--violet)" font-size="10" font-family="monospace">● Latency Trend</text>
      \`;
    }

    function openNewRunModal() {
      document.getElementById("newRunModal").classList.add("open");
    }

    function closeNewRunModal() {
      document.getElementById("newRunModal").classList.remove("open");
    }

    function applyPromptTemplate(type) {
      const ta = document.getElementById("inputUserPrompt");
      if (!ta) return;
      if (type === 'four_line') {
        ta.value = "Add a GET /api/tags endpoint returning {tags: [{tag, count}]}\\nWhere: src/server.ts, tests/server.test.ts\\nDone means: GET /api/tags returns counts, and tests pass\\nOut of scope: tag editing UI, tag filtering";
      } else if (type === 'feature') {
        ta.value = "Implement feature: <Describe capability>\\nWhere: src/\\nDone means: End-to-end functionality working and covered by tests\\nOut of scope: Complex frontend styling";
      } else if (type === 'bugfix') {
        ta.value = "Fix bug: <Describe symptom and reproduction steps>\\nWhere: src/\\nDone means: Bug resolved without regression in existing test suite\\nOut of scope: Unrelated refactoring";
      } else if (type === 'scout') {
        ta.value = "Scout & inspect codebase for <target architecture / symbol>\\nWhere: src/, contracts/\\nDone means: Structured report with findings and line references\\nOut of scope: Any file mutations (read-only recon)";
      }
    }

    function toggleDetCmdInput() {
      const kind = document.getElementById("inputExecutionKind").value;
      const group = document.getElementById("groupDeterministicCommand");
      if (group) {
        group.style.display = kind === "code" ? "block" : "none";
      }
    }

    async function submitNewRun() {
      const tenantId = document.getElementById("inputTenantId").value;
      const parentSha = document.getElementById("inputParentSha").value;
      const maxCost = parseInt(document.getElementById("inputMaxCost").value, 10) || 1000;
      const maxFixLoops = parseInt(document.getElementById("inputMaxFixLoops")?.value, 10) || 3;
      const userPrompt = document.getElementById("inputUserPrompt") ? document.getElementById("inputUserPrompt").value.trim() : "";
      const executionKind = document.getElementById("inputExecutionKind") ? document.getElementById("inputExecutionKind").value : "agent";
      const deterministicCommand = executionKind === "code" && document.getElementById("inputDeterministicCommand")
        ? (document.getElementById("inputDeterministicCommand").value.trim() || "npm test")
        : undefined;
      const autoDispatch = document.getElementById("inputAutoDispatch") ? document.getElementById("inputAutoDispatch").checked : true;

      try {
        const res = await fetch("/v1/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tenant_id: tenantId,
            parent_git_sha: parentSha,
            user_prompt: userPrompt || undefined,
            max_fix_loops: maxFixLoops,
            execution_kind: executionKind,
            deterministic_command: deterministicCommand,
            idempotency_key: "idem-" + Date.now() + "-" + Math.random().toString(36).substring(2, 9),
            budget: { max_cost_cents: maxCost }
          })
        });

        const data = await res.json();
        if (res.ok) {
          closeNewRunModal();
          const newId = data.run ? data.run.id : (data.id || null);
          if (newId && autoDispatch) {
            const dispatchPayload = executionKind === "code"
              ? { phase: "test", execution_kind: "code", deterministic_command: deterministicCommand || "npm test", async: true }
              : { phase: "build", async: true };
            await fetch(\`/v1/runs/\${newId}/dispatch\`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(dispatchPayload)
            });
          }
          await fetchRuns();
          if (newId) selectRun(newId);
        } else {
          alert("Create run failed: " + (data.message || data.error));
        }
      } catch (err) {
        alert("Error creating run: " + err.message);
      }
    }

    async function submitLiveE2eRun() {
      const tenantId = document.getElementById("inputTenantId").value;
      const parentSha = document.getElementById("inputParentSha").value;
      const userPrompt = document.getElementById("inputUserPrompt") ? document.getElementById("inputUserPrompt").value.trim() : "";
      const executionKind = document.getElementById("inputExecutionKind") ? document.getElementById("inputExecutionKind").value : "code";
      const deterministicCommand = executionKind === "code" && document.getElementById("inputDeterministicCommand")
        ? (document.getElementById("inputDeterministicCommand").value.trim() || "echo 'Live sandbox run complete' > output/phase_result.json")
        : undefined;

      try {
        const res = await fetch("/v1/runs/live-e2e", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tenant_id: tenantId,
            parent_git_sha: parentSha,
            user_prompt: userPrompt || undefined,
            execution_kind: executionKind,
            deterministic_command: deterministicCommand,
            auto_harvest: true,
            async: true
          })
        });

        const data = await res.json();
        if (res.ok) {
          closeNewRunModal();
          const newId = data.runId;
          await fetchRuns();
          if (newId) {
            selectRun(newId);
          }
        } else {
          alert("Failed to launch live E2E run: " + (data.message || data.error));
        }
      } catch (err) {
        alert("Error launching live E2E run: " + err.message);
      }
    }

    async function dispatchSelectedRun() {
      if (!selectedRunId) return;
      const run = allRuns.find(r => r.id === selectedRunId);
      const isCode = run && run.envelope?.execution_kind === "code";
      const detCmd = run && run.envelope?.deterministic_command;
      const btn = document.getElementById("btnDispatchSandbox");
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = "<span>⏳ Dispatching...</span>";
      }

      try {
        const payload = isCode
          ? { phase: "test", execution_kind: "code", deterministic_command: detCmd || "npm test", async: true }
          : { phase: "build", async: true };
        const res = await fetch(\`/v1/runs/\${selectedRunId}/dispatch\`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
          await fetchRuns();
          await selectRun(selectedRunId);
        } else {
          alert("Dispatch failed: " + (data.message || data.error));
        }
      } catch (err) {
        alert("Error dispatching run: " + err.message);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = "<span>🚀 Dispatch Live Sandbox</span>";
        }
      }
    }

    async function triggerTailscalePrune() {
      const btn = document.getElementById("pruneBtn");
      if (!confirm("Run automated Tailscale ephemeral sandbox node & key cleanup cycle now?")) {
        return;
      }
      if (btn) btn.textContent = "Pruning...";

      try {
        const res = await fetch("/v1/tailscale/prune", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dryRun: false })
        });
        const data = await res.json();
        if (res.ok) {
          const nPruned = data.nodesPruned ? data.nodesPruned.length : 0;
          const kPruned = data.keysPruned ? data.keysPruned.length : 0;
          alert("Pruning Completed in " + data.durationMs + "ms!\\n- Pruned Nodes: " + nPruned + "\\n- Pruned Keys: " + kPruned + "\\n- Protected Skipped: " + data.protectedNodesSkipped + "\\n- Active Retained: " + data.activeNodesRetained);
          refreshAll();
        } else {
          alert("Pruning failed: " + (data.message || data.error));
        }
      } catch (err) {
        alert("Error executing pruning: " + err.message);
      } finally {
        if (btn) btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> Prune Nodes';
      }
    }
  </script>
</body>
</html>`;
}
