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

Geplant:

- [ ] parameterbezogene Optimierung anhand realer Benchmark-Ergebnisse
- [ ] reichhaltigere Lineage-Evidenz anhand der Repository-Historie
- [ ] Origin-Inference mit expliziten Confidence- und Evidenzregeln

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

Das Benchmarkschema 0.2 profiliert zusätzlich den echten Retrieval-Pfad: Shard-I/O, komprimierte und dekomprimierte Bytes, Stage-Timings, Kandidatenentwicklung, Hinweise auf ausgelassene Hot-Anchors und deterministische Slow-Query-Zusammenfassungen. Dieses diagnostische Profiling verändert die Trace-Semantik nicht und benötigt keinen Index-Neubau. Timing-Werte hängen stark von Speicher, Betriebssystem und Cache-Zustand ab; Benchmark-Ausgaben enthalten niemals Skill-Quelltext.

Die Variantensuche ist approximativ. Der Benchmark meldet den exakten Jaccard-Wert normalisierter 5-Token-Shingles getrennt von der Sketch-Schätzung, einschließlich Recall für Mutationen mit einem exakten Wert von mindestens 0,70. Aggregierte Diagnosen zeigen Verluste bei Kandidatengenerierung und Filterung; `--details-output` schreibt bei Bedarf Einzeldiagnosen ohne Skill-Quelltext. Ältere Indizes müssen wegen der geänderten Anchor-Shard-Zuordnung im Indexschema 0.2 mit dem aktuellen Builder neu erstellt werden.

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
