import { LoaderCircle, Star } from "lucide-react";
import type { ReactNode } from "react";

export function AIGeneratedBadge({ text = "AI 生成" }: { text?: string }) {
  return <span className="ai-badge">{text}</span>;
}

export function AnimatedStarToggle({
  checked,
  disabled,
  onToggle,
}: {
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`star-toggle ${checked ? "checked" : ""}`}
      onClick={onToggle}
      disabled={disabled}
      aria-label={checked ? "已加入生词本" : "加入生词本"}
    >
      <Star size={18} fill={checked ? "currentColor" : "none"} />
    </button>
  );
}

export function LoadingInline({ text }: { text: string }) {
  return (
    <div className="inline-loading">
      <LoaderCircle size={16} className="spinning" />
      <span>{text}</span>
    </div>
  );
}

export function SectionTitle({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="section-title">
      <div>
        <h3>{title}</h3>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}
