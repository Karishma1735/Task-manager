"use client";

import { useState } from "react";

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** Copies a plain-text report to the clipboard. Never sends anything anywhere. */
export function CopyButton({ label, getText }: { label: string; getText: () => Promise<string> | string }) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const [text, setText] = useState("");

  return (
    <div>
      <button
        type="button"
        className="btn"
        onClick={async () => {
          const t = await getText();
          setText(t);
          setState((await writeClipboard(t)) ? "copied" : "manual");
          if (typeof window !== "undefined") window.setTimeout(() => setState((s) => (s === "copied" ? "idle" : s)), 3000);
        }}
      >
        {label}
      </button>
      <p role="status" className="hint mt-1 min-h-[1.4em]">{state === "copied" ? "Copied to clipboard." : ""}</p>
      {state === "manual" && (
        <div className="mt-2">
          <label className="label" htmlFor="copy-fallback">Copy this text manually</label>
          <textarea id="copy-fallback" readOnly rows={8} className="field font-mono text-sm" value={text} onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}
    </div>
  );
}
