// Tiny "click to copy" helper used everywhere we surface a piece of
// connection metadata (host, port, URL, etc.). Falls back gracefully
// when the Clipboard API is unavailable (e.g. plain HTTP origins).

import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";

interface Props {
  value: string;
  label?: string;
  size?: "default" | "sm" | "icon";
}

export function CopyButton({ value, label = "Copy", size = "sm" }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Last-resort fallback for non-secure contexts: select + execCommand.
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size={size}
      onClick={copy}
      className="gap-1.5"
    >
      {copied ? <Check className="text-success" /> : <Copy />}
      {size !== "icon" && (
        <span className="text-xs">{copied ? "Copied" : label}</span>
      )}
    </Button>
  );
}
