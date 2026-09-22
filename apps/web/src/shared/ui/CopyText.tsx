import React, { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "./controls.tsx";
export function CopyText({
  value,
  label,
  rows = 4,
  buttonLabel = "Скопировать",
  successText = "Скопировано",
  collapsible = false,
  buttonVariant,
  writeText = (text: string) => navigator.clipboard.writeText(text),
}: {
  value: string;
  label: string;
  rows?: number;
  buttonLabel?: string;
  successText?: string;
  collapsible?: boolean;
  buttonVariant?: "primary" | "secondary";
  writeText?: (text: string) => Promise<void>;
}) {
  const [result, setResult] = useState<{value:string;state:"copying"|"copied"|"failed"}|null>(null);
  const state=result?.value===value?result.state:"idle";
  const currentValue=useRef(value);currentValue.current=value;
  const attempt=useRef(0);
  useEffect(()=>()=>{attempt.current++;},[]);
  const area = useRef<HTMLTextAreaElement>(null);
  const preview = useRef<HTMLDetailsElement>(null);
  const text = <textarea ref={area} readOnly value={value} rows={rows} aria-label={label}/>;
  return (
    <div className="copy-text">
      {collapsible ? <details ref={preview}><summary>Посмотреть текст для агента</summary>{text}</details> : text}
      <div className="copy-row">
        <Button
          type="button"
          variant={buttonVariant ?? (collapsible ? "primary" : "secondary")}
          busy={state === "copying"}
          onClick={async () => {
            const request=++attempt.current;
            setResult({value,state:"copying"});
            try {
              await writeText(value);
              if(request!==attempt.current||currentValue.current!==value)return;
              setResult({value,state:"copied"});
            } catch {
              if(request!==attempt.current||currentValue.current!==value)return;
              setResult({value,state:"failed"});
              if(preview.current)preview.current.open=true;
              area.current?.focus();
              area.current?.select();
            }
          }}
        >
          {state === "copied" ? <Check /> : <Copy />}{" "}
          {state === "copied" ? successText : buttonLabel}
        </Button>
        {state === "failed" && (
          <span className="field-note" role="status">
            Браузер не дал скопировать — текст выделен.
          </span>
        )}
      </div>
    </div>
  );
}
