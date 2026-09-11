# SkillLineage

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

Geplant:

- [ ] approximative globale Suche nach Varianten-Kandidaten
- [ ] Benchmarking von Indexgröße und Lookup-Performance mit realen GitSkills-Daten
- [ ] reichhaltigere Lineage-Evidenz anhand der Repository-Historie
- [ ] Origin-Inference mit expliziten Confidence- und Evidenzregeln
- [ ] GitHub-Action-/CI-Integration

## Entwicklung

Voraussetzungen:

- Node.js 18+
- npm
- Python 3 für den Offline-GitSkills-Index-Builder

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
```

Die Analyse-Engines sind bewusst von der CLI-Darstellung getrennt, damit sie später auch in CI, GitHub Actions oder anderen Anwendungen wiederverwendet werden können.

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
