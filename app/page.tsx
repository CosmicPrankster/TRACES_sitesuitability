import { loadMembranes } from "@/lib/data";
import ReportView from "./ReportView";

export default function Page() {
  const membranes = loadMembranes();

  return <ReportView membranes={membranes.map((m) => ({ id: m.id, label: m.label, poreSizeUm: m.poreSizeUm }))} />;
}
