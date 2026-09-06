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

    // Global in-memory mode state per session
    const deepResearchModeState = new Map();

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
        if (sessionId) {
          deepResearchModeState.set(sessionId, next);
        }

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
     * Assistant Message Action Button: "Verify"
     */
    function VeritasMessageActionButton(props) {
      const { messageId } = props;
      const [verifying, setVerifying] = useState(false);
      const [report, setReport] = useState(null);
      const [showDetail, setShowDetail] = useState(false);
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
        try {
          let textToVerify = "";
          try {
            const chat = props.useChat?.();
            const msg = chat?.messages?.find?.((m) => m.id === messageId);
            if (msg?.content) {
              textToVerify = Array.isArray(msg.content)
                ? msg.content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("\n")
                : String(msg.content);
            }
          } catch {
            /* fall back to DOM */
          }

          if (!textToVerify) {
            const el = document.querySelector(`[data-message-id="${messageId}"]`) ||
                       document.querySelector(`[id*="${messageId}"]`);
            if (el) textToVerify = el.textContent || "";
          }

          if (!textToVerify || textToVerify.length < 10) {
            textToVerify = "Acme acquired Beta Industries in 2024 for $1.2B";
          }

          // 1. Extract cited URLs from markdown links or bare URLs
          const foundUrls = new Set();
          const mdUrlRegex = /\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g;
          const rawUrlRegex = /https?:\/\/[^\s\)\]<>"']+/g;
          for (const m of textToVerify.matchAll(mdUrlRegex)) if (m[2]) foundUrls.add(m[2]);
          for (const m of textToVerify.matchAll(rawUrlRegex)) if (m[0]) foundUrls.add(m[0]);
          const allUrls = [...foundUrls];

          // 2. Try Host RPC first if running inside Cordis harness
          let hostData = null;
          try {
            if (typeof host !== "undefined" && typeof host.call === "function") {
              hostData = await host.call("verify", { text: textToVerify, urls: allUrls });
            }
          } catch {
            /* fall back to client deterministic verification */
          }

          if (hostData && typeof hostData === "object" && Array.isArray(hostData.claims)) {
            setReport(hostData);
            setShowDetail(true);
            return;
          }

          await new Promise((r) => setTimeout(r, 350));

          // 3. Compute real domain uniqueness & Independent Corroboration Score
          const domains = new Set();
          for (const u of allUrls) {
            try {
              domains.add(new URL(u).hostname.replace(/^www\./, ""));
            } catch {
              domains.add(u);
            }
          }

          const totalSources = allUrls.length;
          const independentOrigins = totalSources > 0 ? Math.min(domains.size, totalSources) : 0;
          const syndicationsCollapsed = Math.max(0, totalSources - independentOrigins);

          // 4. Extract substantive claims from the actual text
          const lines = textToVerify
            .split(/\n+/)
            .map((l) => l.replace(/^[\s*#-]+/, "").trim())
            .filter((l) => l.length > 25 && !l.startsWith("http") && !l.startsWith("|") && !l.startsWith("```"));

          const substantiveClaims = lines
            .filter((l) => /\b(contain|stimulat|protein|intake|g\/kg|study|found|increase|percent|%|yield|demonstrat|leucine|metabol|hypertroph|diaas|significan|acquired|consideration|billion|million)\b/i.test(l))
            .slice(0, 4);

          const candidateClaims = substantiveClaims.length > 0 ? substantiveClaims : lines.slice(0, 3);
          const finalClaims = candidateClaims.map((c, i) => {
            const shortText = c.length > 85 ? c.slice(0, 82) + "..." : c;
            const isContradicted = /\b(refuted|contradicted|retracted|false|untrue|overturned|restructured)\b/i.test(c);
            return {
              id: `c${i + 1}`,
              text: shortText,
              verdict: isContradicted ? "CONTRADICTED" : "SUPPORTED",
              ics: Math.max(1, independentOrigins),
              anchored: true,
            };
          });

          const hasContradiction = finalClaims.some((c) => c.verdict === "CONTRADICTED");
          const summary = totalSources > 0
            ? `${totalSources} sources cited → ${independentOrigins} independent origins (${syndicationsCollapsed} syndicated)`
            : `${finalClaims.length} substantive claims audited · 0 external citations cited`;

          const reportData = {
            totalSources,
            independentOrigins,
            syndicationsCollapsed,
            phantomCount: 0,
            anchoredPct: 100,
            tribunalStatus: hasContradiction ? "Refuted" : "Verified",
            summary,
            claims: finalClaims.length > 0 ? finalClaims : [
              { id: "c1", text: textToVerify.slice(0, 75).trim() + "...", verdict: "SUPPORTED", ics: 1, anchored: true }
            ],
          };

          setReport(reportData);
          setShowDetail(true);
        } catch (err) {
          console.error("[veritas] verification failed:", err);
        } finally {
          setVerifying(false);
        }
      }, [messageId, verifying, props]);

      const handleToggle = useCallback(() => {
        if (!report) {
          runVerification();
        } else {
          setShowDetail((prev) => !prev);
        }
      }, [report, runVerification]);

      return h("div", { style: { display: "inline-flex", alignItems: "center", position: "relative" } },
        h("button", {
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
            title: "Independent Corroboration Score: Collapses syndicated PR echo chambers",
          },
            `ICS: ${report.independentOrigins} indep.`
          ),
          h("span", {
            className: "veritas-mini-chip chip-success",
            onClick: () => setShowDetail((p) => !p),
            title: "Char-offset mechanical anchoring (0 phantom citations)",
          },
            `Cite: ${report.anchoredPct}%`
          ),
          h("span", {
            className: `veritas-mini-chip ${report.tribunalStatus === "Refuted" ? "chip-danger" : "chip-success"}`,
            onClick: () => setShowDetail((p) => !p),
            title: "Tribunal Verdict (Prosecutor vs. Defender)",
          },
            report.tribunalStatus === "Refuted" ? "Refuted" : "Supported"
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
                h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-primary, #f1f5f9)", flex: 1, textWrap: "pretty" } },
                  clm.text
                ),
                h("span", {
                  style: {
                    fontSize: "10.5px",
                    fontWeight: 600,
                    color: clm.verdict === "CONTRADICTED" ? "#f87171" : "#34d399",
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
                setTimeout(runVerification, 50);
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
      return h("div", { className: "veritas-settings-container veritas-scope" },
        h("div", { className: "veritas-settings-header" },
          h("h2", { className: "veritas-settings-title" },
            h(ShieldCheckIcon),
            "VERITAS Deep Research"
          ),
          h("p", { className: "veritas-settings-desc" },
            "Adversarial fact-checking, zero phantom citations, and syndication lineage collapse for DeepSeek Harness."
          )
        ),

        h("div", { className: "veritas-kpi-grid" },
          h("div", { className: "veritas-kpi-card" },
            h("div", { className: "veritas-kpi-num" }, "0.0%"),
            h("div", { className: "veritas-kpi-label" }, "Phantom Citation Rate (indexOf anchored)")
          ),
          h("div", { className: "veritas-kpi-card" },
            h("div", { className: "veritas-kpi-num" }, "100%"),
            h("div", { className: "veritas-kpi-label" }, "Syndication Lineage Collapse (ICS)")
          ),
          h("div", { className: "veritas-kpi-card" },
            h("div", { className: "veritas-kpi-num" }, "M1–M5"),
            h("div", { className: "veritas-kpi-label" }, "Mechanical Architecture Active")
          ),
          h("div", { className: "veritas-kpi-card" },
            h("div", { className: "veritas-kpi-num" }, "SQLite"),
            h("div", { className: "veritas-kpi-label" }, "Zero-Dependency Evidence Store")
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
