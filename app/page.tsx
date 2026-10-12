import { loadHydrocyclones, loadMembranes, loadTrials } from "@/lib/data";
import { psdForCharacter } from "@/lib/psd";
import { assessSite } from "@/lib/assessment";
import { buildReport } from "@/lib/report";
import type { ParticleCharacter } from "@/lib/character";
import ReportView, { type CharacterData } from "./ReportView";

const CHARACTERS: ParticleCharacter[] = ["sand", "mixed_mineral", "silt", "clay"];

export default function Page() {
  const hydrocyclones = loadHydrocyclones();
  const membranes = loadMembranes();
  const trials = loadTrials();

  const byCharacter: Record<ParticleCharacter, CharacterData> = {} as Record<ParticleCharacter, CharacterData>;
  for (const character of CHARACTERS) {
    const psd = psdForCharacter(character);
    const assessments = assessSite(psd, membranes, hydrocyclones, trials);
    const report = buildReport(psd, assessments, membranes);
    byCharacter[character] = { psd, assessments, report };
  }

  return (
    <ReportView
      hydrocyclones={hydrocyclones.map((h) => ({ id: h.id, name: h.name }))}
      membranes={membranes.map((m) => ({ id: m.id, label: m.label, poreSizeUm: m.poreSizeUm }))}
      byCharacter={byCharacter}
    />
  );
}
