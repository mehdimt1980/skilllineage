# SkillLineage

[![CI](https://github.com/mehdimt1980/skilllineage/actions/workflows/ci.yml/badge.svg)](https://github.com/mehdimt1980/skilllineage/actions/workflows/ci.yml)

**Kopien, Varianten und Herkunftshinweise von AI Agent Skills nachvollziehen.**

[English](README.md) | **Deutsch**

SkillLineage ist ein experimentelles Open-Source-CLI, das untersucht, wie `SKILL.md`-Dateien im wachsenden Agent-Skills-Ökosystem miteinander zusammenhängen.

Es verwendet deterministische Fingerprints und normalisierte Instruction-Vergleiche, um Fragen wie diese zu beantworten:

- Ist dieser Skill eine exakte Kopie eines anderen?
- Enthält er dieselben Instructions, aber andere Metadaten oder Zeilenenden?
- Worin unterscheiden sich zwei lokale Skills?
- In welchen anderen Repositories kommt derselbe Skill-Inhalt in einem aus GitSkills abgeleiteten Index vor?

> SkillLineage liefert Evidenz, keine historische Gewissheit. Es behauptet derzeit **nicht**, welches Repository die ursprüngliche Quelle eines Skills ist.

## Aktuelle Funktionen

### Einen Skill fingerprinten

```bash
skilllineage fingerprint ./my-skill
```

Erzeugt deterministische Fingerprints für:

- die unveränderten Bytes von `SKILL.md`
- Git-Blob-SHA-1
- den normalisierten Instruction-Body
- das vollständige Skill-Bundle
- das Datei-Inventar

### Zwei Skills vergleichen

```bash
skilllineage compare ./skill-a ./skill-b
```

Klassifiziert die Beziehung als eine der folgenden Kategorien:

- `identical_bundle`
- `same_skill_md`
- `same_instructions`
- `variant`
- `different`

Der lokale Variantenvergleich verwendet eine deterministische Jaccard-Ähnlichkeit auf Basis von 5-Token-Shingles.

### Einen Skill gegen einen Index zurückverfolgen

```bash
skilllineage trace ./my-skill --index ./gitskills-index
```

Aktuelle Trace-Priorität:

```text
exakt gleicher Rohinhalt
    ↓
gleiche normalisierte Instructions
    ↓
Kandidaten mit hoher textueller Ähnlichkeit
    ↓
kein Treffer
```

Der Index wird aus GitSkills-Metadaten abgeleitet und bewusst getrennt vom CLI gehalten.

## Warum SkillLineage?

Agent Skills werden zunehmend kopiert, angepasst, umbenannt, gebündelt und über verschiedene Repositories und Agent-Ökosysteme verteilt. Die reine Dateiidentität reicht dabei nicht aus: Metadaten können sich ändern, während die Instructions identisch bleiben, und unterstützende Dateien können auseinanderdriften, obwohl die zentrale `SKILL.md` unverändert bleibt.

SkillLineage schafft eine deterministische Evidenzschicht, um diese Entwicklung nachvollziehbar zu machen.

Langfristig soll Skill-Herkunft leichter überprüfbar werden — ohne Abhängigkeit von einem LLM, einer Vektordatenbank oder undurchsichtigen Similarity-Scores.

## Designprinzipien

- **Determinismus zuerst** — identische Eingaben erzeugen identische Ausgaben.
- **Keine Runtime-Abhängigkeiten** — die Kernfunktionen verwenden ausschließlich die Node.js-Standardbibliothek.
- **Keine Ausführung von Skills** — analysierte Skill-Dateien werden niemals ausgeführt.
- **Evidenz statt Behauptungen** — Ähnlichkeit wird nicht als Beweis für Kopieren oder Urheberschaft dargestellt.
- **Local-first-Analyse** — Fingerprinting und Vergleich funktionieren vollständig mit lokalen Dateien.
- **Index-freundlich** — globales Matching verwendet kompakte abgeleitete Indizes statt des vollständigen Quelldatensatzes.

## Projektstatus

SkillLineage befindet sich derzeit in einem **frühen / experimentellen Stadium**.

Implementiert:

- [x] deterministisches Skill-Fingerprinting
- [x] Git-kompatibles Blob-Hashing
- [x] Bundle-Hashing und Datei-Inventar
- [x] lokaler Skill-Vergleich
- [x] Matching normalisierter Instructions
- [x] kompakter, geshardeter Exact-Match-Index
- [x] GitSkills-basierter Index-Builder
- [x] globaler Exact-Trace
- [x] globaler Same-Instructions-Trace
- [x] approximative globale Suche nach Varianten-Kandidaten
- [x] GitHub-Actions-CI mit Node.js 22 und 24
- [x] manueller Benchmark für echte GitSkills-Daten
- [x] Full-Scale-Retrieval-Profiling
- [x] Schema-0.3-Microsharding für Variant-Sketches
- [x] Schema-0.4 mit vorab berechneten Variant-Enrichment-Summaries
- [x] Schema-0.5 mit Summaries historischer Datensatz-Beobachtungen
- [x] Trace-Schema 0.2 mit nutzerseitig sichtbarer beobachteter Historien-Evidenz

Geplant:

- [ ] parameterbezogene Optimierung anhand realer Benchmark-Ergebnisse
- [ ] Origin-Inference nur, falls zukünftige Evidenzregeln sie ausdrücklich tragen können

## Entwicklung

Voraussetzungen:

- Node.js 22+
- npm
- Python 3.13 für den Offline-GitSkills-Index-Builder und die Benchmark-Harness

Abhängigkeiten installieren:

```bash
npm install
```

Prüfungen ausführen:

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

Das gebaute CLI starten:

```bash
node dist/cli/main.js --help
```

## Architektur

```text
src/
  cli/          Command-Dispatch und Serialisierung
  fingerprint/  deterministische Skill-Fingerprints
  compare/      lokale Beziehungs- und Ähnlichkeitsanalyse
  index/        statische Index-Reader und Typen
  trace/        globale Trace-Engine

tools/
  build-gitskills-index.py
  benchmark-gitskills.py
  run-trace-benchmark.mjs
```

Die Analyse-Engines sind bewusst von der CLI-Darstellung getrennt, damit sie später auch in CI, GitHub Actions oder anderen Anwendungen wiederverwendet werden können.

## Indexschema 0.4

Schema 0.4 behält das mit Schema 0.3 eingeführte Vier-Hex-Microsharding für Variant-Sketches bei und ergänzt sparse, vorab berechnete Enrichment-Summaries für normalisierte Instruction-Hashes.

Variant-Sketches werden weiterhin anhand der ersten vier Hex-Zeichen der `variantId` geroutet:

```text
variants/sketches/a1/b2.json.gz
```

Variant-Enrichment-Summaries werden unabhängig davon anhand der ersten vier Hex-Zeichen des vollständigen SHA-256 der normalisierten Instructions geroutet:

```text
variants/enrichment/a1/b2.json.gz
```

Es werden nur nichtleere Sketch- und Enrichment-Microshards geschrieben. Die Enrichment-Summaries enthalten ausschließlich die statischen Daten, die für die Darstellung der finalen Variant-Kandidaten benötigt werden: Anzahl der Raw-Varianten, deduplizierte Copy-Anzahl und bis zu drei deterministisch sortierte Repository-/Pfad-Beispiele. Skill-Quelltext und normalisierter Instruction-Text werden nicht gespeichert.

Zur Trace-Zeit werden diese Summaries nicht mehr durch das Lesen von Instruction-Shards und mehreren Exact-Shards rekonstruiert. Finale Variant-Kandidaten lesen direkt die benötigten Enrichment-Microshards, höchstens einmal pro eindeutiger Enrichment-Route. Fehlende oder fehlerhafte erforderliche Enrichment-Daten gelten als inkonsistenter Index und erfordern einen Neuaufbau.

Der Matching-Algorithmus bleibt unverändert: Normalisierung, 5-Token-Shingles, Bottom-32-Sketch, Anchor-Generierung, geschätzte Similarity, Schwellenwerte, Caps, Ranking und Trace-Priorität ändern sich nicht. Schema 0.4 ist eine Index-/Runtime-I/O-Optimierung; es führt keine historische Origin-Inference ein und verändert die Similarity-Semantik nicht.

Schema-0.3- und ältere Indizes sind nicht mit dem Schema-0.4-Reader kompatibel.

## Indexschema 0.5: Grundlage für beobachtete Historie

Schema 0.5 ergänzt sparse Microshards unter `history/exact/aa/bb.json.gz` und `history/instructions/aa/bb.json.gz`. Das Routing verwendet die ersten vier Hex-Zeichen des kleingeschriebenen Git-Blob-SHA-1 beziehungsweise des vollständigen SHA-256 der normalisierten Instructions. Die Summaries zählen eindeutige Repository-/Pfad-Orte, abgerufene Historie, nutzbare Zeitstempel, Chronologie-Anomalien und widersprüchliche Duplikate. Früheste und späteste **Beobachtungen im Datensatz** werden deterministisch in UTC gespeichert. `none`, `partial` und `complete` beschreiben nur die Abdeckung der indexierten Orte.

Diese Zeitstempel belegen weder Ursprung noch Urheberschaft oder Kopierrichtung. Die historische Abdeckung in GitSkills ist unvollständig. Schema-0.4-Indizes müssen für den Schema-0.5-Reader neu erzeugt werden; Matching und Ranking bleiben unverändert.

Die normale `trace`-Ausgabe zeigt die im Schema-0.5-Index gespeicherten Beobachtungen; eingeführt wurde dies mit dem öffentlichen Trace-Schema 0.2. Exakte Treffer verwenden die Historie des passenden Git-Blobs, Treffer mit gleichen Instructions die Historie der normalisierten Instruction-Gruppe. Jeder finale Variant-Kandidat erhält seine eigene Instruction-Gruppen-Historie. Ein fehlender sparse Datensatz ergibt `not_available` mit `no_stored_history`; ein leerer normalisierter Instruction-Text ergibt `empty_normalized_instructions` für die Instruction-Historie. Die exakte Raw-Content-Historie bleibt dabei nutzbar.

`earliestObserved` ist die früheste nutzbare Beobachtung unter den indexierten Orten der gespeicherten Evidenz, **kein** Ursprung. `none`, `partial` und `complete` beschreiben die nutzbare Historie der eindeutigen indexierten Repository-/Pfad-Orte einer Gruppe. `complete` bedeutet, dass alle diese Orte nutzbare Historie haben; es bedeutet keine vollständige globale historische Abdeckung von GitSkills. `origin.status` bleibt `not_inferred`; Zeitstempel beeinflussen weder Matching noch Ranking.

Trace-Schema 0.3 ergänzt `temporalEvidence` ausschließlich bei `variant_candidates`. Für jedes Paar finaler Kandidaten werden die bereits geladenen Zeitstempel `earliestObserved.firstCommitAt` verglichen. Die Reihenfolge der Relationen folgt dem bestehenden Kandidaten-Ranking. Die Aussage beschränkt sich darauf, welche Instruction-Gruppe im indexierten Datensatz zuerst beobachtet wurde oder ob beide erstmals zur selben Zeit beobachtet wurden. Ohne nutzbare Historie bleibt ein Paar unvergleichbar; die Ausgabe zählt vergleichbare und unvergleichbare Paare. Partielle Abdeckung erlaubt einen Beobachtungsvergleich, lässt aber das historische Bild unvollständig. Die zeitliche Reihenfolge beweist weder, welcher Skill außerhalb des Datensatzes zuerst existierte, noch welches Repository eine Quelle ist oder ob ein Kandidat von einem anderen kopiert wurde. Ranking und History-I/O bleiben unverändert.

## Continuous Integration

GitHub Actions führt Linting, Type-Checks, synthetische Tests und den Build unter Ubuntu mit Node.js 22 und 24 sowie Python 3.13 aus. Ein zusätzlicher Windows-Job führt Tests und Build mit Node.js 24 und Python 3.13 aus, um Dateisystem- und Pfadregressionen zu erkennen. Die CI besitzt ausschließlich Leserechte und lädt weder GitSkills herunter noch führt sie Benchmarks mit Echtdaten aus.

## Benchmarking mit GitSkills

Der Benchmark mit Echtdaten wird ausschließlich manuell ausgeführt. Er benötigt eine lokale GitSkills-SQLite-Datenbank, einen bereits erzeugten SkillLineage-Index und ein kompiliertes `dist/`-Verzeichnis:

```bash
npm run build
python tools/benchmark-gitskills.py \
  --db /pfad/zu/gitskills.db \
  --index /pfad/zum/skilllineage-index \
  --samples 100 \
  --seed 42 \
  --output benchmark-report.json \
  --details-output benchmark-details.json
```

Die Harness zieht deterministische Stichproben realer Skills und misst Indexgröße, In-Process-Trace-Latenz, Exact- und Same-Instructions-Trefferraten sowie Recall@1/3/10 für kontrollierte leichte und mittlere Mutationen. Sie verändert oder lädt den Quelldatensatz nicht herunter und läuft nicht in der CI. `--keep-temp` dient ausschließlich der gezielten Untersuchung erzeugter Fixtures.

Das Benchmarkschema 0.2 profiliert zusätzlich den echten Retrieval-Pfad: Shard-I/O, komprimierte und dekomprimierte Bytes, Stage-Timings, Kandidatenentwicklung, Hinweise auf ausgelassene Hot-Anchors, deterministische Slow-Query-Zusammenfassungen sowie separates I/O für `variant_enrichment`, `history_exact` und `history_instructions`. Die Indexgrößenmetriken erfassen rekursiv Variant-Enrichment und beide History-Bereiche. Dieses diagnostische Profiling verändert die Matching-Semantik nicht. Timing-Werte hängen stark von Speicher, Betriebssystem und Cache-Zustand ab; Benchmark-Ausgaben enthalten niemals Skill-Quelltext.

Die Variantensuche ist approximativ. Der Benchmark meldet den exakten Jaccard-Wert normalisierter 5-Token-Shingles getrennt von der Sketch-Schätzung, einschließlich Recall für Mutationen mit einem exakten Wert von mindestens 0,70. Aggregierte Diagnosen zeigen Verluste bei Kandidatengenerierung und Filterung; `--details-output` schreibt bei Bedarf Einzeldiagnosen ohne Skill-Quelltext. Schema-0.3- und ältere Indizes müssen vor Trace oder Benchmark mit dem aktuellen Builder neu erzeugt werden.
## Audit historischer Metadaten (Phase 11A)

Phase 11 untersucht die Einbindung historischer Repository-Metadaten in die Lineage-Analyse. Bevor historische Aussagen oder Indexänderungen eingeführt werden, stellt Phase 11A ein Offline-Audit-Tool bereit, um Abdeckung, Konsistenz und Konfliktraten von Zeitstempeln in der GitSkills-Datenbank schreibgeschützt zu prüfen:

```bash
python tools/audit-gitskills-history.py \
  --db /pfad/zu/agent_skills_release.db \
  --output history-audit.json
```

Zentrale Prinzipien des Audits:

- **Ausschließlich beobachtete Evidenz** — Zeitstempel spiegeln Datensatz-Beobachtungen wider, keine Beweise für Urheberschaft, Fork-Ursprünge oder Kopierrichtungen.
- **Strikter Lesezugriff** — Die Quelldatenbank wird im Read-Only-Modus geöffnet und niemals verändert.
- **Keine Laufzeitänderungen** — `skilllineage trace` und Indexschemas enthalten in dieser Phase weder historische Inferenz noch temporales Ranking.

## GitSkills-Hinweis

Der Offline-Index-Builder von SkillLineage ist dafür ausgelegt, Lineage-Metadaten aus dem **GitSkills**-Datensatz abzuleiten.

GitSkills-Metadaten und -Aggregationen werden unter **CC BY 4.0** bereitgestellt. Der Skill-Quellinhalt unterliegt weiterhin den Lizenzen der ursprünglichen Repositories. Deshalb konzentriert SkillLineage seine abgeleiteten Indizes auf Hashes und Lineage-Metadaten, statt Skill-Quelltexte weiterzuverteilen.

GitSkills-Datensatz:

- https://huggingface.co/datasets/mvaccargiu/gitskills

## Was SkillLineage nicht behauptet

Ein übereinstimmender Hash oder eine hohe textuelle Ähnlichkeit beweist für sich allein nicht:

- ursprüngliche Urheberschaft
- Plagiat
- bösartige Veränderung
- eine historische Fork-Beziehung
- einen Supply-Chain-Angriff

Solche Schlussfolgerungen benötigen zusätzliche Repository- und historische Evidenz.

## Lizenz

MIT © 2026 Mehdi Mirabian Tabar
