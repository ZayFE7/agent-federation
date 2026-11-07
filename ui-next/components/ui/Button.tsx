import React, { ButtonHTMLAttributes, forwardRef, ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

type Variant =
  | "primary"
  | "secondary"
  | "ghost"
  | "accent"
  | "danger"
  | "subtle";
type Size = "sm" | "md" | "lg" | "icon" | "icon-sm";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  iconRight?: ReactNode;
  loading?: boolean;
}

const variants: Record<Variant, string> = {
  primary: "bg-ink text-canvas hover:bg-ink/90 shadow-soft",
  accent: "bg-accent text-on-accent hover:bg-accent/90 shadow-soft",
  secondary:
    "bg-surface text-ink border border-line hover:border-line-strong shadow-[0_1px_0_rgb(var(--line)/0.7)]",
  ghost: "text-ink-2 hover:text-ink hover:bg-ink/[0.05]",
  subtle: "bg-ink/[0.05] text-ink hover:bg-ink/[0.08]",
  danger: "bg-rose text-on-accent hover:bg-rose/90 shadow-soft",
};

const sizes: Record<Size, string> = {
  sm: "min-h-[44px] md:min-h-0 md:h-8 px-3 text-[13px] gap-1.5 rounded-[10px]",
  md: "min-h-[44px] md:min-h-0 md:h-10 px-4 text-sm gap-2 rounded-xl",
  lg: "h-12 px-5 text-[15px] gap-2 rounded-xl",
  icon: "h-11 w-11 md:h-9 md:w-9 rounded-xl",
  "icon-sm": "h-11 w-11 md:h-8 md:w-8 rounded-lg",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size = "md",
      icon,
      iconRight,
      loading,
      className = "",
      children,
      disabled,
      type = "button",
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || loading}
        className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium select-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0 ${variants[variant]} ${sizes[size]} ${className}`}
        {...rest}
      >
        {loading ? <LoaderCircle className="animate-spin" aria-hidden /> : icon}
        {children}
        {iconRight}
      </button>
    );
  },
);
