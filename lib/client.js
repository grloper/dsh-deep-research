(function () {
  function createVeritasClientPlugin(require) {
    const React = (typeof require === "function" ? require("react") : null) || globalThis.React || {
      createElement: () => null,
      useState: (init) => [init, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useRef: () => ({ current: null }),
    };
    const { useState, useEffect, useCallback, useMemo, useRef } = React;
    const h = React.createElement;

    const STYLE_ID = "dsh-veritas-client-style";

    const cssText = `
      .veritas-scope {
        font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }

      /* Composer Toggle Button: subtle, quiet pill matching native composer tools */
      .veritas-composer-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 26px;
        padding: 0 10px;
        font-size: 12px;
        font-weight: 500;
        letter-spacing: -0.01em;
        border-radius: 6px;
        cursor: pointer;
        border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
        background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.03));
        color: var(--dsw-alias-label-secondary, #94a3b8);
        transition: color 150ms ease, background-color 150ms ease, border-color 150ms ease, transform 100ms ease;
        user-select: none;
        outline: none;
        line-height: 1;
      }
      .veritas-composer-btn:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.07));
        color: var(--dsw-alias-label-primary, #f1f5f9);
        border-color: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.16));
      }
      .veritas-composer-btn:active {
        transform: scale(0.97);
      }
      .veritas-composer-btn.active {
        background: rgba(56, 189, 248, 0.08);
        border-color: rgba(56, 189, 248, 0.3);
        color: #38bdf8;
      }
      .veritas-composer-indicator {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: var(--dsw-alias-label-tertiary, #64748b);
        transition: background-color 150ms ease;
      }
      .veritas-composer-btn.active .veritas-composer-indicator {
        background: #38bdf8;
        box-shadow: 0 0 5px rgba(56, 189, 248, 0.5);
      }

      /* Assistant Message Action Button: crisp, minimal icon action */
      .veritas-action-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 24px;
        padding: 0 8px;
        font-size: 11px;
        font-weight: 500;
        letter-spacing: -0.01em;
        border-radius: 5px;
        cursor: pointer;
        border: 1px solid transparent;
        background: transparent;
        color: var(--dsw-alias-label-tertiary, #64748b);
        transition: color 150ms ease, background-color 150ms ease, border-color 150ms ease, transform 100ms ease;
        user-select: none;
        outline: none;
        vertical-align: middle;
      }
      .veritas-action-btn:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.06));
        color: var(--dsw-alias-label-secondary, #94a3b8);
        border-color: var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.06));
      }
      .veritas-action-btn:active {
        transform: scale(0.97);
      }
      .veritas-action-btn.active {
        background: var(--dsw-alias-interactive-bg-active, rgba(255, 255, 255, 0.08));
        color: var(--dsw-alias-label-primary, #f1f5f9);
        border-color: var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1));
      }

      /* Compact, quiet status chips row */
      .veritas-chips-row {
        display: inline-flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 4px;
        margin-left: 6px;
        vertical-align: middle;
      }
      .veritas-mini-chip {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        height: 20px;
        padding: 0 6px;
        font-size: 10.5px;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        border-radius: 4px;
        background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.04));
        border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.07));
        color: var(--dsw-alias-label-secondary, #94a3b8);
        white-space: nowrap;
        cursor: pointer;
        transition: border-color 150ms ease, background-color 150ms ease;
      }
      .veritas-mini-chip:hover {
        border-color: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.14));
        background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.06));
      }
      .veritas-mini-chip.chip-accent {
        color: #38bdf8;
        border-color: rgba(56, 189, 248, 0.2);
        background: rgba(56, 189, 248, 0.04);
      }
      .veritas-mini-chip.chip-success {
        color: #34d399;
        border-color: rgba(52, 211, 153, 0.2);
        background: rgba(52, 211, 153, 0.04);
      }
      .veritas-mini-chip.chip-danger {
        color: #f87171;
        border-color: rgba(248, 113, 113, 0.25);
        background: rgba(248, 113, 113, 0.06);
      }

      /* Clean, modern inspection popover */
      .veritas-popover {
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        z-index: 1000;
        width: 360px;
        max-width: calc(100vw - 32px);
        border-radius: 8px;
        padding: 12px 14px;
        background: var(--dsw-specific-menu, #1c1c22);
        border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1));
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35), 0 2px 6px rgba(0, 0, 0, 0.15);
        font-size: 12px;
        line-height: 1.45;
        color: var(--dsw-alias-label-primary, #e2e8f0);
        animation: veritas-fade-in 140ms ease-out;
      }
      @keyframes veritas-fade-in {
        from { opacity: 0; transform: translateY(-3px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .veritas-popover-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding-bottom: 8px;
        margin-bottom: 8px;
        border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.07));
      }
      .veritas-popover-title {
        font-size: 12px;
        font-weight: 600;
        letter-spacing: -0.01em;
        color: var(--dsw-alias-label-primary, #f1f5f9);
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .veritas-claim-row {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      }
      .veritas-claim-row:last-child {
        border-bottom: none;
        padding-bottom: 0;
      }

      /* Settings View: restrained, minimalist, Apple/Vercel-level */
      .veritas-settings-container {
        display: flex;
        flex-direction: column;
        gap: 18px;
        padding: 0 0 32px;
        max-width: 640px;
        color: var(--dsw-alias-label-primary, inherit);
      }
      .veritas-settings-header {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
      }
      .veritas-settings-title {
        font-size: 16px;
        font-weight: 600;
        letter-spacing: -0.01em;
        margin: 0;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .veritas-settings-desc {
        font-size: 13px;
        color: var(--dsw-alias-label-secondary, #94a3b8);
        margin: 0;
        line-height: 1.45;
        text-wrap: pretty;
      }
      .veritas-kpi-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 10px;
      }
      .veritas-kpi-card {
        padding: 12px 14px;
        border-radius: 7px;
        background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.025));
        border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.07));
      }
      .veritas-kpi-num {
        font-size: 18px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.02em;
        color: var(--dsw-alias-label-primary, #f1f5f9);
      }
      .veritas-kpi-label {
        font-size: 11px;
        color: var(--dsw-alias-label-secondary, #94a3b8);
        margin-top: 2px;
      }
      .veritas-section-card {
        border-radius: 7px;
        background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.02));
        border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.07));
        padding: 14px 16px;
      }
      .veritas-row-item {
        display: flex;
        align-items: baseline;
        gap: 10px;
        padding: 8px 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        font-size: 12px;
        line-height: 1.5;
      }
      .veritas-row-item:last-child {
        border-bottom: none;
        padding-bottom: 0;
      }
      .veritas-tag {
        font-size: 10px;
        font-weight: 600;
        padding: 1px 5px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: var(--dsw-alias-label-secondary, #94a3b8);
        flex: none;
        font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      }
    `;

    // Per-session Deep Research toggle state.
    //
    // Bounded on purpose: an unbounded Map keyed by session id grows for the
    // lifetime of the tab. Only active sessions matter, so the oldest entry is
    // evicted past a small cap, and the whole map is cleared on plugin unload.
    const MAX_TRACKED_SESSIONS = 50;
    const deepResearchModeState = new Map();
    function setSessionMode(sessionId, value) {
      if (!sessionId) return;
      if (deepResearchModeState.has(sessionId)) deepResearchModeState.delete(sessionId);
      deepResearchModeState.set(sessionId, value);
      while (deepResearchModeState.size > MAX_TRACKED_SESSIONS) {
        deepResearchModeState.delete(deepResearchModeState.keys().next().value);
      }
    }

    /** Verdict → colour, shared by every surface so the palette cannot drift. */
    const VERDICT_COLORS = {
      SUPPORTED: "#34d399",
      PARTIAL: "#fbbf24",
      NEUTRAL: "#94a3b8",
      CONTRADICTED: "#f87171",
      UNVERIFIED: "#94a3b8",
    };

    // Minimalist SVG Icons (optically aligned, 13x13 and 14x14)
    function CompassIcon() {
      return h("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
        h("circle", { cx: 12, cy: 12, r: 10 }),
        h("polygon", { points: "16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" })
      );
    }

    function ShieldCheckIcon() {
      return h("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
        h("path", { d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" }),
        h("path", { d: "m9 12 2 2 4-4" })
      );
    }

    /**
     * Composer Action Button: Toggles Deep Research Mode
     */
    function VeritasComposerButton(props) {
      const [isActive, setIsActive] = useState(false);
      const sessionId = props.sessionId;

      useEffect(() => {
        if (sessionId) {
          setIsActive(Boolean(deepResearchModeState.get(sessionId)));
        }
      }, [sessionId]);

      const toggleMode = useCallback(() => {
        const next = !isActive;
        setIsActive(next);
        setSessionMode(sessionId, next);

        try {
          const inputState = props.useInput?.();
          const currentText = inputState?.text || inputState?.draft || "";
          const updateDraft = (t) => {
            if (typeof props.inputActions?.setDraft === "function") {
              props.inputActions.setDraft(t);
            } else if (typeof props.inputActions?.setText === "function") {
              props.inputActions.setText(t);
            }
          };

          if (next) {
            if (!currentText.startsWith("/deep_research") && !currentText.includes("[VERITAS]")) {
              updateDraft(`[VERITAS Deep Research] ${currentText}`);
            }
          } else {
            if (currentText.startsWith("[VERITAS Deep Research] ")) {
              updateDraft(currentText.replace("[VERITAS Deep Research] ", ""));
            }
          }
        } catch {
          /* optional input integration */
        }
      }, [isActive, sessionId, props]);

      return h("button", {
        type: "button",
        className: `veritas-composer-btn ${isActive ? "active" : ""}`,
        onClick: toggleMode,
        title: isActive
          ? "Deep Research Mode active: Routes prompts through adversarial tribunal (click to turn off)"
          : "Toggle Deep Research Mode (VERITAS)",
      },
        h("span", { className: "veritas-composer-indicator" }),
        h(CompassIcon),
        h("span", null, isActive ? "Deep Research Active" : "Deep Research")
      );
    }

    /**
     * Read the assistant message text that should be verified.
     *
     * Slot props are the owner of this data, so they are consulted first and the
     * rendered DOM is only a last resort. The previous implementation inverted
     * that order and scraped guessed container selectors (".chat-turn",
     * "article") before ever looking at props, which silently captured sidebars,
     * tool output, and neighbouring turns.
     *
     * Only leaf scalars are read — never a whole Snapshot object.
     *
     * @param {object} props slot props
     * @param {string} messageId target message
     * @param {Element|null} btn this button's DOM node, for the fallback only
     * @returns {string}
     */
    function readMessageText(props, messageId, btn) {
      // 1. Direct scalar text supplied by the slot owner.
      if (typeof props.text === "string" && props.text.trim()) return props.text;
      if (typeof props.content === "string" && props.content.trim()) return props.content;

      // 2. Structured message blocks from the conversation snapshot selector.
      try {
        if (typeof props.useChat === "function") {
          const blocks = props.useChat((s) => {
            const nodes = s && s.nodes && typeof s.nodes.values === "function" ? s.nodes.values() : null;
            if (!nodes) return null;
            const list = Array.from(nodes);
            const target =
              list.find((n) => n && n.messageId === messageId) ||
              list.filter((n) => n && n.kind === "assistant").at(-1);
            if (!target || !Array.isArray(target.blocks)) return null;
            // Project to plain strings inside the selector so no live node escapes.
            return target.blocks
              .filter((b) => b && b.kind === "text" && typeof b.text === "string")
              .map((b) => b.text);
          });
          if (Array.isArray(blocks) && blocks.length > 0) return blocks.join("\n");
        }
      } catch {
        /* selector shape differs on this host; fall through */
      }

      // 3. Last resort: the nearest rendered turn container around this button.
      try {
        if (btn && typeof btn.closest === "function") {
          const container =
            btn.closest("[data-message-id]") ||
            btn.closest("[data-turn]") ||
            btn.closest("article");
          if (container) {
            const clone = container.cloneNode(true);
            // Drop our own controls so the report never verifies its own chrome.
            for (const el of clone.querySelectorAll(".veritas-scope, .veritas-action-btn, .veritas-chips-row, .veritas-popover")) {
              el.remove();
            }
            return (clone.innerText || clone.textContent || "").trim();
          }
        }
      } catch {
        /* no usable DOM anchor */
      }
      return "";
    }

    /**
     * Assistant Message Action Button: "Verify"
     */
    function VeritasMessageActionButton(props) {
      const { messageId } = props;
      const [verifying, setVerifying] = useState(false);
      const [report, setReport] = useState(null);
      const [error, setError] = useState(null);
      const [showDetail, setShowDetail] = useState(false);
      const buttonRef = useRef(null);
      const popoverRef = useRef(null);

      // Dismiss popover on outside click or Escape
      useEffect(() => {
        if (!showDetail) return;
        const onKeyDown = (e) => {
          if (e.key === "Escape") setShowDetail(false);
        };
        const onPointerDown = (e) => {
          if (popoverRef.current && !popoverRef.current.contains(e.target)) {
            setShowDetail(false);
          }
        };
        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("mousedown", onPointerDown);
        return () => {
          document.removeEventListener("keydown", onKeyDown);
          document.removeEventListener("mousedown", onPointerDown);
        };
      }, [showDetail]);

      const runVerification = useCallback(async () => {
        if (verifying) return;
        setVerifying(true);
        setError(null);
        try {
          const textToVerify = readMessageText(props, messageId, buttonRef.current);

          if (!textToVerify || textToVerify.trim().length < 15) {
            setError("No message text was available to verify.");
            setShowDetail(true);
            return;
          }

          // The verdict is produced ONLY by the Host engine, which mechanically
          // anchors every quote in fetched source text. There is deliberately no
          // client-side fallback: a browser cannot fetch and anchor sources, so
          // any in-page "verdict" would be a guess, and a guess rendered next to
          // the word "Verified" is worse than no answer at all.
          if (typeof host === "undefined" || typeof host.call !== "function") {
            setError("The VERITAS host engine is not reachable from this page.");
            setShowDetail(true);
            return;
          }

          const hostData = await host.call("verify", { text: textToVerify });

          if (!hostData || hostData.ok !== true || !Array.isArray(hostData.claims)) {
            setError(
              hostData && hostData.error === "empty-text"
                ? "No check-worthy factual claims were found in this message."
                : "The host engine could not complete verification."
            );
            setShowDetail(true);
            return;
          }

          setReport(hostData);
          setShowDetail(true);
        } catch (err) {
          setError("Verification failed: " + (err && err.message ? err.message : "unknown error"));
          setShowDetail(true);
        } finally {
          setVerifying(false);
        }
      }, [messageId, verifying, props]);

      const handleToggle = useCallback(() => {
        if (!report && !error) {
          runVerification();
        } else {
          setShowDetail((prev) => !prev);
        }
      }, [report, error, runVerification]);

      // Derived, honest summary counters straight from the host report.
      const totals = report && report.totals ? report.totals : null;
      const maxIcs = report
        ? report.claims.reduce((m, c) => (c.ics > m ? c.ics : m), 0)
        : 0;
      const anchoredPct = report && report.claims.length > 0
        ? Math.round((report.claims.filter((c) => c.anchored).length / report.claims.length) * 100)
        : 0;
      const refuted = Boolean(totals && totals.contradicted > 0);

      return h("div", { style: { display: "inline-flex", alignItems: "center", position: "relative" } },
        h("button", {
          ref: buttonRef,
          type: "button",
          className: `veritas-action-btn ${report ? "active" : ""}`,
          onClick: handleToggle,
          title: report ? "Toggle verification details" : "Mechanically verify factual claims & citation anchoring",
        },
          h(ShieldCheckIcon),
          h("span", null, verifying ? "Verifying..." : report ? "Verified" : "Verify")
        ),

        report && h("div", { className: "veritas-chips-row" },
          h("span", {
            className: "veritas-mini-chip chip-accent",
            onClick: () => setShowDetail((p) => !p),
            title: "Independent Corroboration Score: syndicated copies of one origin collapse to a single origin",
          },
            `ICS: ${maxIcs} indep.`
          ),
          h("span", {
            className: "veritas-mini-chip chip-success",
            onClick: () => setShowDetail((p) => !p),
            title: "Share of claims carrying at least one mechanically anchored citation",
          },
            `Anchored: ${anchoredPct}%`
          ),
          report.phantomRate > 0 && h("span", {
            className: "veritas-mini-chip chip-danger",
            onClick: () => setShowDetail((p) => !p),
            title: "Proposed citations rejected because the quote was not found in the source",
          },
            `Phantom: ${report.phantomRate}%`
          ),
          h("span", {
            className: `veritas-mini-chip ${refuted ? "chip-danger" : "chip-success"}`,
            onClick: () => setShowDetail((p) => !p),
            title: "Aggregate verdict across all adjudicated claims",
          },
            refuted ? "Contradicted" : "Supported"
          )
        ),

        showDetail && error && h("div", { ref: popoverRef, className: "veritas-popover" },
          h("div", { className: "veritas-popover-header" },
            h("span", { className: "veritas-popover-title" }, h(ShieldCheckIcon), "Verification unavailable"),
            h("button", {
              type: "button",
              style: { background: "transparent", border: "none", color: "var(--dsw-alias-label-tertiary, #94a3b8)", cursor: "pointer", fontSize: "14px", lineHeight: 1, padding: "2px 4px" },
              onClick: (e) => { e.stopPropagation(); setShowDetail(false); setError(null); },
              title: "Close (Esc)",
            }, "×")
          ),
          h("div", { style: { fontSize: "11.5px", color: "var(--dsw-alias-label-secondary, #94a3b8)", lineHeight: 1.5 } }, error),
          h("div", { style: { marginTop: "10px", display: "flex", justifyContent: "flex-end" } },
            h("button", {
              type: "button",
              style: { background: "var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05))", border: "1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.1))", color: "var(--dsw-alias-label-secondary, #94a3b8)", fontSize: "11px", padding: "3px 8px", borderRadius: "4px", cursor: "pointer" },
              onClick: () => { setError(null); runVerification(); },
            }, "Retry")
          )
        ),

        showDetail && report && h("div", { ref: popoverRef, className: "veritas-popover" },
          h("div", { className: "veritas-popover-header" },
            h("span", { className: "veritas-popover-title" },
              h(ShieldCheckIcon),
              "Claim Adjudication"
            ),
            h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
              h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #64748b)" } },
                "VERITAS M1–M3"
              ),
              h("button", {
                type: "button",
                style: {
                  background: "transparent",
                  border: "none",
                  color: "var(--dsw-alias-label-tertiary, #94a3b8)",
                  cursor: "pointer",
                  fontSize: "14px",
                  lineHeight: 1,
                  padding: "2px 4px",
                  borderRadius: "4px",
                },
                onClick: (e) => {
                  e.stopPropagation();
                  setShowDetail(false);
                },
                title: "Close (Esc)",
              }, "×")
            )
          ),
          h("div", { style: { fontSize: "11px", color: "var(--dsw-alias-label-secondary, #94a3b8)", marginBottom: "8px" } },
            report.summary
          ),
          h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", maxHeight: "180px", overflowY: "auto" } },
            report.claims.map((clm) =>
              h("div", { key: clm.id || clm.text, className: "veritas-claim-row" },
                h("div", { style: { flex: 1, minWidth: 0 } },
                  h("div", { style: { fontSize: "11px", color: "var(--dsw-alias-label-primary, #f1f5f9)", textWrap: "pretty" } },
                    clm.text
                  ),
                  // Show the anchored quote itself — the whole point of M1 is that
                  // the user can see the exact span the verdict rests on.
                  Array.isArray(clm.citations) && clm.citations.length > 0 && h("div", {
                    style: { marginTop: "4px", fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #64748b)", borderLeft: "2px solid rgba(56,189,248,0.35)", paddingLeft: "6px", lineHeight: 1.45 },
                  },
                    h("span", null, "\u201C" + clm.citations[0].quote.slice(0, 140) + "\u201D"),
                    clm.citations[0].url && h("div", { style: { marginTop: "2px", opacity: 0.75, wordBreak: "break-all" } },
                      "[" + clm.citations[0].anchorKind + "] " + clm.citations[0].url
                    )
                  ),
                  h("div", { style: { marginTop: "3px", fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #64748b)" } },
                    `${Math.round((clm.confidence || 0) * 100)}% confidence · ICS ${clm.ics} / ${clm.sourceCount} source${clm.sourceCount === 1 ? "" : "s"}`
                  )
                ),
                h("span", {
                  style: {
                    fontSize: "10.5px",
                    fontWeight: 600,
                    color: VERDICT_COLORS[clm.verdict] || "#94a3b8",
                    flex: "none",
                    marginLeft: "8px",
                  }
                },
                  clm.verdict
                )
              )
            )
          ),
          h("div", { style: { borderTop: "1px solid rgba(255, 255, 255, 0.06)", marginTop: "8px", paddingTop: "8px", display: "flex", justifyContent: "flex-end" } },
            h("button", {
              type: "button",
              style: {
                background: "var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.05))",
                border: "1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1))",
                color: "var(--dsw-alias-label-secondary, #94a3b8)",
                fontSize: "11px",
                padding: "3px 8px",
                borderRadius: "4px",
                cursor: "pointer",
              },
              onClick: () => {
                setReport(null);
                setError(null);
                runVerification();
              },
            }, "Re-verify")
          )
        )
      );
    }

    /**
     * Settings Section: Clean, minimal dashboard
     */
    function VeritasSettingsView() {
      // Live counters from the Host evidence store. The previous version rendered
      // "0.0%" and "100%" as static text, which asserted a measured guarantee the
      // UI had never actually measured — exactly the failure mode this project
      // exists to prevent. Now every number is real or explicitly unknown.
      const [stats, setStats] = useState(null);
      const [statsError, setStatsError] = useState(null);

      useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            if (typeof host === "undefined" || typeof host.call !== "function") {
              if (!cancelled) setStatsError("Host engine not reachable from this page.");
              return;
            }
            const s = await host.call("stats", {});
            if (cancelled) return;
            if (s && s.ok) setStats(s);
            else setStatsError("Evidence store unavailable.");
          } catch (err) {
            if (!cancelled) setStatsError(err && err.message ? err.message : "Could not read evidence store.");
          }
        })();
        return () => { cancelled = true; };
      }, []);

      const kpi = (value, label) =>
        h("div", { className: "veritas-kpi-card" },
          h("div", { className: "veritas-kpi-num" }, value),
          h("div", { className: "veritas-kpi-label" }, label)
        );

      return h("div", { className: "veritas-settings-container veritas-scope" },
        h("div", { className: "veritas-settings-header" },
          h("h2", { className: "veritas-settings-title" },
            h(ShieldCheckIcon),
            "VERITAS Deep Research"
          ),
          h("p", { className: "veritas-settings-desc" },
            "Adversarial fact-checking, mechanically anchored citations, and syndication lineage collapse for DeepSeek Harness."
          )
        ),

        statsError && h("div", {
          style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #64748b)", padding: "10px 12px", borderRadius: "7px", border: "1px dashed var(--dsw-alias-border-l1, rgba(255,255,255,0.12))" },
        }, statsError),

        h("div", { className: "veritas-kpi-grid" },
          kpi(stats ? String(stats.claims) : "—", "Claims in evidence graph"),
          kpi(stats ? String(stats.entities) : "—", "Distinct entities indexed"),
          kpi(stats ? String(stats.sources) : "—", "Sources retained"),
          kpi(
            stats ? (stats.backend === "sqlite" ? "SQLite" : stats.backend === "json" ? "JSON" : "—") : "—",
            stats && stats.persistent ? "Evidence store (persistent)" : "Evidence store (ephemeral)"
          )
        ),

        h("div", { className: "veritas-section-card" },
          h("div", { style: { fontSize: "13px", fontWeight: 600, marginBottom: "8px", color: "var(--dsw-alias-label-primary, #f1f5f9)" } },
            "Active Verification Pipeline"
          ),
          h("div", { className: "veritas-row-item" },
            h("span", { className: "veritas-tag" }, "M1"),
            h("div", null,
              h("strong", { style: { color: "var(--dsw-alias-label-primary, #f1f5f9)" } }, "Char-Offset Anchoring: "),
              "Citations require exact verbatim substring matches in source text with byte offsets."
            )
          ),
          h("div", { className: "veritas-row-item" },
            h("span", { className: "veritas-tag" }, "M2"),
            h("div", null,
              h("strong", { style: { color: "var(--dsw-alias-label-primary, #f1f5f9)" } }, "Lineage DAG & ICS: "),
              "MinHash shingling and Tarjan SCC collapse syndicated media into true origin roots."
            )
          ),
          h("div", { className: "veritas-row-item" },
            h("span", { className: "veritas-tag" }, "M3"),
            h("div", null,
              h("strong", { style: { color: "var(--dsw-alias-label-primary, #f1f5f9)" } }, "Adversarial Tribunal: "),
              "Dedicated prosecutor queries actively search disconfirming regulatory filings."
            )
          ),
          h("div", { className: "veritas-row-item" },
            h("span", { className: "veritas-tag" }, "M4"),
            h("div", null,
              h("strong", { style: { color: "var(--dsw-alias-label-primary, #f1f5f9)" } }, "Date Resolution: "),
              "Extracts JSON-LD and HTTP headers to defeat retro-dated blog edits."
            )
          ),
          h("div", { className: "veritas-row-item" },
            h("span", { className: "veritas-tag" }, "M5"),
            h("div", null,
              h("strong", { style: { color: "var(--dsw-alias-label-primary, #f1f5f9)" } }, "Evidence Graph: "),
              "Caches verified claims with classified volatility horizons in local SQLite."
            )
          )
        )
      );
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        // 1. Inject Stylesheet cleanly
        ctx.effect(() => {
          let styleEl = document.getElementById(STYLE_ID);
          if (!styleEl) {
            styleEl = document.createElement("style");
            styleEl.id = STYLE_ID;
            styleEl.textContent = cssText;
            document.head.appendChild(styleEl);
          } else {
            styleEl.textContent = cssText;
          }
          return () => {
            styleEl?.remove();
            // Drop per-session UI state so a reload/update starts clean.
            deepResearchModeState.clear();
          };
        }, "dsh-deep-research: styles");

        // 2. Register Assistant Message Action Button
        ctx.slots.inject("conversation.chat.assistant-actions", () =>
          ctx.slots.register({
            name: "conversation.chat.assistant-actions",
            id: "veritas-verify-action",
            order: 5,
            label: () => "Verify",
          }, (props) => h(VeritasMessageActionButton, props))
        );

        // 3. Register Composer Tool Row Button
        ctx.slots.inject("conversation.input.left", () =>
          ctx.slots.register({
            name: "conversation.input.left",
            id: "veritas-composer-toggle",
            order: 25,
            label: () => "Deep Research",
          }, (props) => h(VeritasComposerButton, props))
        );

        // 4. Register Settings Section
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register({
            name: "settings.section",
            id: "veritas-settings",
            order: 14,
            label: () => "Veritas Research",
          }, (props) => h(VeritasSettingsView, props))
        );
      },
    };
  }

  const loader =
    typeof window !== "undefined" && window.__ModuleLoader__
      ? window.__ModuleLoader__
      : typeof globalThis !== "undefined" && globalThis.__ModuleLoader__
      ? globalThis.__ModuleLoader__
      : null;

  if (loader && typeof loader.load === "function") {
    loader.load({
      id: "dsh-deep-research",
      factory: createVeritasClientPlugin,
    });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { factory: createVeritasClientPlugin };
  }
})();
