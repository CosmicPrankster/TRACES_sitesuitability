import { loadHydrocyclones, loadMembranes } from "@/lib/data";
import ReportView from "./ReportView";

export default function Page() {
  const hydrocyclones = loadHydrocyclones();
  const membranes = loadMembranes();

  return (
    <ReportView
      hydrocyclones={hydrocyclones.map((h) => ({ id: h.id, name: h.name }))}
      membranes={membranes.map((m) => ({ id: m.id, label: m.label, poreSizeUm: m.poreSizeUm }))}
    />
  );
}
