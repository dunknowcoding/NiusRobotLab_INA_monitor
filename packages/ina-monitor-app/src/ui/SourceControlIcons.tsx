import React from "react";

const S = { viewBox: "0 0 24 24" as const, width: 20, height: 20, fill: "currentColor", "aria-hidden": true as const };

/** Icon-only control; use title + aria-label for tooltips / a11y */
export function IconConnect(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="btnIcon" {...props}>
      <svg {...S}>
        <path d="M13 7h-2v4H7v2h4v4h2v-4h4v-2h-4V7zm-1-5C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z" />
      </svg>
    </button>
  );
}

export function IconDisconnect(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="btnIcon btnIconDanger" {...props}>
      <svg {...S}>
        <path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59 20.41 17 17 13.41 12 17z" />
      </svg>
    </button>
  );
}

export function IconStart(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="btnIcon btnIconOk" {...props}>
      <svg {...S}>
        <path d="M8 5v14l11-7L8 5z" />
      </svg>
    </button>
  );
}

export function IconStop(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="btnIcon" {...props}>
      <svg {...S}>
        <path d="M6 6h12v12H6V6z" />
      </svg>
    </button>
  );
}
