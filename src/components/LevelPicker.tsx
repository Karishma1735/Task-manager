"use client";

import { LEVELS, LEVEL_HINTS, LEVEL_NAMES } from "@/lib/scoring";

export function LevelPicker({
  name,
  value,
  onChange,
  legend = "Value level",
}: {
  name: string;
  value: number | null;
  onChange: (n: number) => void;
  legend?: string;
}) {
  return (
    <fieldset>
      <legend className="label">{legend}</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {LEVELS.map((l) => (
          <label
            key={l}
            className={`group relative cursor-pointer rounded-xl border p-3 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-cherry ${
              value === l ? "border-cherry bg-cherry-soft" : "border-line bg-bg hover:border-muted"
            }`}
          >
            <input
              type="radio"
              name={name}
              value={l}
              checked={value === l}
              onChange={() => onChange(l)}
              className="sr-only"
              required
            />
            <span className="display block text-3xl leading-none">{l}</span>
            <span className="mt-1 block text-sm font-bold">{LEVEL_NAMES[l]}</span>
            <span className="sr-only">{LEVEL_HINTS[l]}</span>
          </label>
        ))}
      </div>
      <p className="hint mt-2">
        {value ? LEVEL_HINTS[value as 1 | 2 | 4 | 8] : "One multiplier outweighs eight upkeep tasks. Be honest — a reviewer will confirm."}
      </p>
    </fieldset>
  );
}
