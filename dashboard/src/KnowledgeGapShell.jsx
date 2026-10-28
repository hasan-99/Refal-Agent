import React, { useEffect } from "react";
import { X } from "lucide-react";

// Shared by the Knowledge Gaps page and its lazily loaded details drawer.

export async function request(url, options = {}) {
  const response = await fetch(url, { credentials: "include", cache: "no-store", ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status}).`);
    error.payload = body;
    error.status = response.status;
    throw error;
  }
  return body;
}

export function DrawerShell({ onClose, children = null, label = "Knowledge gap details" }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div className="kg-drawer-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="kg-drawer" role="dialog" aria-modal="true" aria-label={label}>
      {children || <DrawerSkeleton onClose={onClose} />}
    </aside>
  </div>;
}

export function DrawerSkeleton({ onClose }) {
  return <>
    <header className="kg-drawer-head">
      <div className="kg-drawer-title">
        <span className="kg-card-tags"><span className="kg-skeleton-pill" /><span className="kg-skeleton-pill wide" /></span>
        <span className="kg-skeleton-line" style={{ width: "70%", height: 18 }} />
        <span className="kg-skeleton-line" style={{ width: "48%" }} />
      </div>
      <button type="button" className="kg-icon-button" onClick={onClose} aria-label="Close"><X size={16} /></button>
    </header>
    <div className="kg-drawer-body">
      <span className="kg-skeleton-block tall" />
      {Array.from({ length: 4 }, (_value, index) => <span key={index} className="kg-skeleton-block" />)}
    </div>
  </>;
}
