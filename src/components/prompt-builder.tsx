import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Sparkles, X } from "lucide-react";

import { buildImagePrompt, loadPromptFields, savePromptFields, type ImagePromptFields } from "@/lib/image-prompt";
import { polishScript } from "@/lib/gemini";

type PromptBuilderDialogProps = {
  script: string;
  onScriptCommit: (text: string) => void;
  onClose: () => void;
};

function wordsOf(text: string) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/**
 * Two steps in one place: make the narration speakable, then wrap it in the
 * master prompt for an image model. Only the polish step touches the network,
 * and only when the user asks for it.
 */
export function PromptBuilderDialog({ script, onScriptCommit, onClose }: PromptBuilderDialogProps) {
  const [text, setText] = useState(script);
  const [fields, setFields] = useState<ImagePromptFields>(() => loadPromptFields());
  const [polishing, setPolishing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [copied, setCopied] = useState(false);
  const outputRef = useRef<HTMLTextAreaElement | null>(null);

  const words = wordsOf(text);
  const seconds = Math.max(1, Math.round(words / 2.5));

  const updateField = (patch: Partial<ImagePromptFields>) => {
    setFields((current) => {
      const next = { ...current, ...patch };
      savePromptFields(next);
      return next;
    });
  };

  const finish = () => {
    onScriptCommit(text);
    onClose();
  };

  const polish = async () => {
    setError(null);
    setNotice(null);
    if (!text.trim()) {
      setError("Paste a script first.");
      return;
    }
    setPolishing(true);
    try {
      const polished = await polishScript(text);
      setText(polished);
      onScriptCommit(polished);
      setOutput("");
      setNotice("Polished. Read it once, then build the prompt. This is the text the cues will quote.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Gemini could not polish the script.");
    } finally {
      setPolishing(false);
    }
  };

  const build = () => {
    setError(null);
    try {
      const prompt = buildImagePrompt({ ...fields, script: text });
      setOutput(prompt);
      onScriptCommit(text);
      setNotice("Prompt ready. The script is inside it, and the project script was updated to match.");
    } catch (caught) {
      setOutput("");
      setError(caught instanceof Error ? caught.message : "Could not build the prompt.");
    }
  };

  const copy = async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      outputRef.current?.focus();
      outputRef.current?.select();
      setError("Clipboard blocked. The prompt is selected — copy it with Ctrl+C.");
    }
  };

  return createPortal(
    <div className="slice-dialog-backdrop" onPointerDown={finish}>
      <div
        className="slice-dialog prompt-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Image prompt builder"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="slice-dialog-head">
          <div>
            <span className="panel-eyebrow">SCRIPT → IMAGE PROMPT</span>
            <h3>Polish the narration, then brief the image model</h3>
          </div>
          <button type="button" className="slice-dialog-close" onClick={finish} aria-label="Close prompt builder">
            <X size={16} />
          </button>
        </header>

        <div className="prompt-body">
          <section className="prompt-column">
            <span className="settings-eyebrow">1 · NARRATION</span>
            <p className="settings-note">
              Paste the spoken words only. Polish fixes grammar and removes accidental repetition that would
              make two cues look alike. The built prompt uses whatever is in this box.
            </p>
            <textarea
              className="prompt-script"
              value={text}
              spellCheck={false}
              rows={12}
              placeholder="Paste only the spoken lines."
              onChange={(event) => {
                setText(event.target.value);
                setNotice(null);
              }}
              onBlur={() => onScriptCommit(text)}
            />
            <span className="prompt-meta">
              {words} words · about {seconds} s spoken
            </span>

            <div className="prompt-actions">
              <button
                type="button"
                className="prompt-primary"
                onClick={() => void polish()}
                disabled={polishing || !text.trim()}
              >
                <Sparkles size={12} />
                {polishing ? "Polishing…" : "Polish with Gemini"}
              </button>
            </div>

            {notice ? <p className="slice-map-ok">{notice}</p> : null}
            {error ? <p className="prompt-error">{error}</p> : null}
          </section>

          <section className="prompt-column">
            <span className="settings-eyebrow">2 · BRIEF</span>
            <p className="settings-note">
              The reference folder and drawing style are fixed, so every project looks the same. Only the
              image count and aspect change.
            </p>

            <div className="prompt-pair">
              <div>
                <label className="field-label" htmlFor="prompt-count">
                  Image count
                </label>
                <input
                  id="prompt-count"
                  className="editor-input"
                  type="text"
                  value={fields.imageCount}
                  placeholder="e.g. 6 — blank = as needed"
                  onChange={(event) => updateField({ imageCount: event.target.value })}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="prompt-aspect">
                  Aspect
                </label>
                <select
                  id="prompt-aspect"
                  className="editor-select"
                  value={fields.aspect}
                  onChange={(event) => updateField({ aspect: event.target.value })}
                >
                  <option value="16:9">16:9</option>
                  <option value="4:3">4:3</option>
                  <option value="1:1">1:1</option>
                  <option value="9:16">9:16</option>
                </select>
              </div>
            </div>

            <div className="prompt-actions">
              <button type="button" className="prompt-primary" onClick={build} disabled={!text.trim()}>
                Build prompt
              </button>
              <button type="button" className="prompt-secondary" onClick={() => void copy()} disabled={!output}>
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? "Copied" : "Copy prompt"}
              </button>
            </div>

            <label className="field-label" htmlFor="prompt-output">
              Ready to paste
            </label>
            <textarea
              id="prompt-output"
              ref={outputRef}
              className="prompt-output"
              value={output}
              readOnly
              rows={14}
              spellCheck={false}
              placeholder="Build the prompt to see the whole text here, script included."
            />
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
