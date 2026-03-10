import React from "react";

type SliderVariant = "storage" | "sync";

interface SliderProps {
  variant: SliderVariant;
  id: string;
  min: number;
  max: number;
  value: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}

export const Slider: React.FC<SliderProps> = ({ variant, id, min, max, value, step, suffix = "", onChange }) => {
  const display = `${value}${suffix}`;

  if (variant === "storage") {
    return (
      <div className="storage-slider-wrap">
        <input
          type="range"
          className="storage-slider"
          id={id}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="storage-slider-value" id={`${id}-val`}>{display}</span>
      </div>
    );
  }

  return (
    <div className="sync-slider-wrap">
      <input
        type="range"
        className="sync-slider"
        id={id}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="sync-slider-val" id={`${id}-val`}>{display}</span>
    </div>
  );
};
