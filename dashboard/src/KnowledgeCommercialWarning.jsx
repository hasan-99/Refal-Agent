import React from "react";
import { ArrowUpRight, CircleDollarSign } from "lucide-react";
import { detectCommercialKnowledgeWarning } from "./knowledgeCommercialWarning.js";
import "./knowledge-commercial-warning.css";

export default function KnowledgeCommercialWarning({ content, onOpenCommercialData }) {
  const warning = detectCommercialKnowledgeWarning(content);
  if (!warning) return null;
  const targets = warning.target ? [warning.target] : warning.tables;
  const detected = [warning.currencyAmount && "a currency amount", warning.propertyReference && "a property reference"].filter(Boolean).join(" and ");
  return (
    <aside className="knowledge-commercial-warning" role="status" aria-live="polite">
      <CircleDollarSign size={17} aria-hidden="true" />
      <div>
        <strong>This text contains {detected}.</strong>
        <p>Keep company identity and noncommercial facts in Knowledge. If this is a current business price, fee, deposit, or property record, enter it in the matching typed table: {targets.map((table, index) => <React.Fragment key={table.id}>{index > 0 ? ", " : ""}<b>{table.label}</b></React.Fragment>)}. The warning does not block saving.</p>
        <button type="button" onClick={onOpenCommercialData}>Open commercial data <ArrowUpRight size={13} /></button>
      </div>
    </aside>
  );
}
