# Post-release аудит архитектуры Engineering Foundation

Статус: независимый аудит release snapshot и последующая remediation/rollout-
валидация завершены 2026-08-23.

Архитектурный snapshot:
`ae9d022a003978e30d33006132beaa5b49fc6f80` (`origin/main`, опубликованные
`@agent-teams/engineering-foundation@0.17.0` и
`@agent-teams/docs-protocol@0.1.0`).

Post-audit closure дополнительно проверен на Foundation repository revision
`608200c49a361a785e631d824c3b79d7e8cacf56` с опубликованным
`@agent-teams/docs-protocol@0.1.1`, controller main
`fdfedb5f76bc74a5bec37bf3afca2290658311ae` и exact default-branch evidence
четырёх реальных consumers. Snapshot-оценка ниже не переписывается задним
числом; отдельно указано текущее состояние системы после remediation.

Это повторная оценка после аудита ревизии
`36d905362955255c3faed930b11a1e6f05a87ee9`. Между ревизиями в `main` вошли
отдельные изменения для границ Docs Protocol, единого capability registry,
детерминированного quality gate runner, recovery characterization, эффективных
инструкций, changed-scope evidence, partitioned coverage и заморозки legacy
Docs CLI.

Аудит основан на исходном коде, manifests, architecture policy, ADR, публичных
контрактах, тестах и exact-head hosted CI. Тесты локально не перезапускались.
Последний полный успешный PR run для release head занял 7 минут 25 секунд:
[CI run 32611325543](https://github.com/agent-teams-ai/engineering-foundation/actions/runs/32611325543).
Agent runtime, provisioning и реальные consumer flows не запускались.

После первоначального read-only прохода governed rollout analysis для RC3 fleet
нашёл дефекты, которые не были видны по зелёному producer CI: опубликованный
stable transition catalog не содержал текущий RC3, а центральный verifier
проверял digest каталога, но не его семантическую достижимость. Поэтому
первоначальная snapshot-оценка 7.8/10 была пересмотрена вниз до 7.3/10.

Затем дефект был исправлен на обеих trust boundaries, Docs Protocol 0.1.1
опубликован, Orchestrator прошёл canary, stable Cohort стал RECOMMENDED, а
Runtime, Extension и Platform последовательно прошли plan/apply, hosted
default-branch gate и central bind. Текущая system-readiness оценка после этого
closure вернулась к 7.8/10.

## Текущая revalidation: 2026-08-25

Исторические оценки и факты ниже сохранены как snapshot. Текущее состояние
проверено на exact PR head
`7d1eb3529b3473efd74a0c8d593c4c5f0fb42dec` и merged main
`393c51ebaa823d9b107fae287416aa821ac53548`. Required PR CI run
`32785270609` и exact-main CI run `32785996812` прошли. Tree merge идентичен
проверенному PR tree.

Опубликованные и развёрнутые stable packages: Engineering Foundation `0.18.0`
и Docs Protocol `0.1.2`. Все четыре real consumers и canary привязаны к
`stable2`. Merged PR #192 закрыл fail-safe lease release, публичную проекцию
known-file recovery, bounded argv JSON, Docs layer fence, широкие test
suppressions и cleanup временных файлов. Автоматический release PR #193
предлагает будущие `0.19.0`/`0.1.3`; эти версии ещё не являются deployed
stable evidence.

Актуальный evidence:

- 141 test file входят в fail-closed manifests: 126 cross-platform и 15
  Docs-specific coverage tests;
- partitioned exact-SHA coverage является blocking authority, а не advisory
  миграцией;
- ADR-0035 фиксирует extraction admission invariant: два реальных consumer,
  parity evidence и удаление дубликатов; тот же ADR задаёт поэтапную миграцию
  публичных concrete seams;
- runtime AgentLoop, replay и plugin platform по-прежнему находятся вне
  ownership Foundation.

Оставшийся долг ограничен и не блокирует новые независимые slices. Capability
contract loaders всё ещё местами смешивают I/O, validation и mapping; concrete
public seams мигрируют по ADR-0035. Fixed qualification timeout и свежесть
shard timing относятся к P3. Отказ optional ReviewRouter не является отказом
required gate.

Текущая итоговая оценка после merge и независимого повторного аудита:
**8.8/10**, P0 = 0, P1 = 0, blocking P2 = 0.
Описанные ниже P1/P2 относятся к историческому snapshot; этот раздел является
актуальной revalidation, а не ретроспективным изменением исходного вердикта.

## Вердикт

**Строгая оценка snapshot 0.17.0/0.1.0: 7.3/10, было 6.2/10. Текущее состояние
после Docs 0.1.1 и полного stable rollout: 7.8/10. P0 не найдено. Один P1
остаётся.**

Foundation достаточно силён для разработки новых независимых feature slices:
направление зависимостей защищено кодом, capabilities являются opt-in, а
проектные проверки остаются у consumer. Governed Docs rollout теперь также
доказан end-to-end на четырёх реальных repositories; новые consumers можно
подключать к RECOMMENDED stable Cohort через тот же staged workflow.

До 9/10 не хватает не новых абстракций, а уменьшения риска уже существующего
кода: production recovery всё ещё сконцентрирован в двух очень больших Node
адаптерах; неожиданные ошибки теряют полезную классификацию; публичный API всё
ещё показывает несколько concrete/fault seams; advisory CI observer не всегда
переваривает отменённые GitHub jobs.

| Критерий | Было | Сейчас |
| --- | ---: | ---: |
| Clean Architecture | 6/10 | 8/10 |
| SOLID | 6/10 | 7/10 |
| DDD и bounded contexts | 6/10 | 8/10 |
| Feature slicing и модульность | 7/10 | 8.5/10 |
| Направление зависимостей | 8/10 | 9/10 |
| Composition roots | 6/10 | 8/10 |
| Registry design | 6/10 | 9/10 |
| Публичный API | 6/10 | 6.5/10 |
| Готовность к новым capabilities | 5/10 | 7.5/10 |
| Тестируемость и evidence | 7/10 | 8/10 |
| Диагностика | 6/10 | 6/10 |
| Bootstrap и self-dogfooding | 8/10 | 8/10 |
| Когнитивная сложность | 4/10 | 5.5/10 |
| Скорость feedback loop | не оценивалась отдельно | 8/10 |

Оценка DDD относится к техническим bounded contexts Foundation. Это не доменная
модель продуктов: [ownership boundary](../architecture/ownership.md) правильно
оставляет бизнес-термины, topology, catalogs и решения в consumer repositories.

## Что изменилось после прошлого аудита

### Закрыто: consumer integration стал настоящим bounded context

Вместо одной плоской границы теперь определены domain, generated assets,
application, adapters и composition в
[`source-dependencies.yaml`](../../architecture/foundation/source-dependencies.yaml).
Application зависит от узких lifecycle/planner ports, а concrete Node,
package-manager и Foundation mutation adapters собираются только в
[`node-consumer-integration.ts`](../../packages/docs-protocol-agent-teams/src/consumer-integration/composition/node-consumer-integration.ts).

Направление защищено golden policy и негативным тестом в
[`package-boundary.test.mjs`](../../tests/package-boundary.test.mjs). Это
закрывает прежнюю P1 по Dependency Inversion и заметно повышает DDD/SOLID.

### Закрыто: двойное владение Docs CLI ограничено совместимостью

ADR-0033 явно заморозил Foundation `docs` namespace. Human mode выдаёт стабильное
предупреждение через
[`legacy-docs-cli-deprecation.ts`](../../packages/engineering-foundation/src/legacy-docs-cli-deprecation.ts),
а machine output сохраняет опубликованный контракт. Новое поведение принадлежит
Docs Protocol. Legacy путь пока существует, но больше не является вторым местом
развития продукта.

### Закрыто: capability и rule registries имеют один источник

[`capability-modules.ts`](../../packages/engineering-foundation/src/composition/capability-modules.ts)
содержит единый статический список descriptors. Capability registry и rule
registry выводятся из него. Тест
[`capability.test.mjs`](../../tests/capability.test.mjs) связывает schema IDs,
runtime IDs, rule ownership, explain metadata и rejection duplicate IDs.

Это правильный Open/Closed компромисс: внутреннее добавление capability требует
одного descriptor, но runtime discovery и исполняемые consumer plugins не
появились.

### Частично закрыто: recovery получил сильную characterization-сетку

[`known-file-transaction-characterization.test.mjs`](../../tests/known-file-transaction-characterization.test.mjs)
фиксирует durable journal shapes, digests, filesystem post-state, apply/recovery
checkpoints и обязательное потребление scripted sequence. Более широкие hostile,
foreign-byte, crash и idempotency сценарии остаются в
[`known-file-transaction-node.test.mjs`](../../tests/known-file-transaction-node.test.mjs).

Это хороший safety harness для рефакторинга, но production структура не стала
проще. Поэтому прежняя P1 не закрыта полностью.

### Закрыто: проектные проверки получили безопасную opt-in композицию

[`quality.gate-runner`](../reference/quality-gate-runner.md) позволяет каждому
consumer собрать свои профили из существующих root `package.json` scripts,
описать `needs`, `after`, concurrency и timeout. Foundation не принимает inline
commands, environment, plugins или shell fragments. Статическая capability
только проверяет конфигурацию; выполнение происходит лишь по явной команде.

Это именно нужный уровень гибкости для разных проектов:

- проект владеет содержанием своих команд;
- Foundation владеет безопасным DAG scheduler, process containment и evidence;
- установка или upgrade ничего не активирует;
- сложные provider/agent/plugin abstractions не проникают в Foundation.

Не надо сейчас делать generic command/plugin framework. Возможное разделение
`task.id` и `task.script` в v2 имеет смысл только когда реальный второй consumer
докажет необходимость нескольких логических tasks поверх одного script.

### Улучшено: feedback loop стал практически пригодным

Linux tests разделены на четыре изолированных shard, coverage/package/registry/
published/static lanes выполняются параллельно, Windows tests разделены на две
части, performance вынесен в advisory workflow. Exact-head release run уложился
в 7:25, а Linux merge aggregate завершился примерно за 5 минут.

Partitioned coverage уже собирается без повторного выполнения shard tests, но
остаётся advisory до доказанной parity. Блокирующий legacy coverage lane пока
сохраняется, что правильно для миграции, хотя временно дублирует работу.

## Закрыто после audit snapshot: Stable Cohort стал deployable

На snapshot опубликованный `@agent-teams/docs-protocol@0.1.0` не содержал direct
target bundle для `docs-2026-08-18-rc3`, а central verifier не доказывал
семантическую достижимость каждого `upgrade_from`. Package integrity,
provenance и producer CI поэтому могли быть зелёными при невозможном реальном
plan/apply.

Пробел закрыт без nominal rollback и без ослабления trust model:

- [Foundation PR 181](https://github.com/agent-teams-ai/engineering-foundation/pull/181)
  добавил exact RC3 bundle и ADR fix-forward lifecycle;
- [controller PR 89](https://github.com/agent-teams-ai/.github/pull/89)
  добавил base-owned semantic deployability verification;
- `@agent-teams/docs-protocol@0.1.1` опубликован с provenance и exact SRI;
- Orchestrator прошёл canary и promotion в RECOMMENDED stable Cohort;
- Runtime, Extension и Platform последовательно прошли consumer merge,
  успешный default-branch Docs gate и central evidence bind.

На controller main `fdfedb5f76bc74a5bec37bf3afca2290658311ae`
`rollout_pending` отсутствует. Orchestrator, Runtime, Extension и Platform имеют
`bound`, exact `0.17.0`/`0.1.1` и один observed Cohort
`docs-2026-08-23-stable1`. Этот P1 закрыт.

## P1

### Recovery остаётся слишком сложным для безопасного изменения

[`node-known-file-transaction-recovery.ts`](../../packages/engineering-foundation/src/repository-mutation/adapters/node/node-known-file-transaction-recovery.ts)
имеет 1,334 строки, а
[`node-known-file-transaction.ts`](../../packages/engineering-foundation/src/repository-mutation/adapters/node/node-known-file-transaction.ts)
- 869 строк. В одном уровне смешаны transition decisions, journal evolution,
identity checks, filesystem effects и orchestration. Четыре временные complexity
waiver для этой области зафиксированы в
[`suppression-governance.yaml`](../../architecture/foundation/suppression-governance.yaml).

Нарушение в первую очередь относится к SRP и DIP. Explicit states и fail-closed
семантика являются сильной стороной и не должны упрощаться. Риск в том, что
маленькое изменение поведения требует одновременно понимать слишком много crash
windows и side effects.

Это не найденный production bug и не P0. Но до следующего изменения recovery
семантики нужен behaviour-preserving structural extraction. Новые независимые
capabilities ждать этого не обязаны.

## P2

### Unexpected errors теряют безопасную причину

[`check-runner.ts`](../../packages/engineering-foundation/src/check-runner.ts) и
все 12 зарегистрированных capability module wrappers превращают неожиданные
исключения в общий
`FOUNDATION_CHECK_FAILED` или `CAPABILITY_EXECUTION_FAILED`. Пользователь видит
phase, но часто не различает filesystem, parser, process и internal invariant
failure.

Нужна общая bounded classification: стабильный cause kind и безопасная phase,
без absolute paths, содержимого repository и secrets. Stack и исходное сообщение
не должны попадать в machine contract.

### Публичный API показывает concrete и qualification seams

[`mutation/index.ts`](../../packages/engineering-foundation/src/mutation/index.ts)
экспортирует concrete Node operations и fault injector types.
[`consumer-integration/index.ts`](../../packages/docs-protocol-agent-teams/src/consumer-integration/index.ts)
экспортирует planners/adapters и Node error рядом с основными use cases.

Это полезно для существующей qualification, но увеличивает стоимость каждого
рефакторинга. Удалять сразу нельзя: public API baseline правильно защищает
consumers. Сначала нужны реальные import-usage данные и migration path, затем
deprecation и только потом major removal.

### Contract folders всё ещё смешивают контракт и inbound I/O

Например,
[`source-dependencies/contract/config.ts`](../../packages/engineering-foundation/src/capabilities/source-dependencies/contract/config.ts)
и
[`contract-json-schema-releases/contract/config.ts`](../../packages/engineering-foundation/src/capabilities/contract-json-schema-releases/contract/config.ts)
одновременно читают YAML/baseline files, валидируют schemas и строят application
models. Некоторые module factories принимают ports, другие создают concrete Node
adapters внутри.

Это bounded debt, а не повод переписывать все capabilities. Разделять loader,
mapper и pure contract стоит только при следующем содержательном изменении
конкретного slice.

### CI observer неустойчив к реальным GitHub timestamp anomalies

Advisory observer дважды упал на отменённых main runs с
`completed_at precedes started_at`:
[run 32611727079](https://github.com/agent-teams-ai/engineering-foundation/actions/runs/32611727079)
и
[run 32611271403](https://github.com/agent-teams-ai/engineering-foundation/actions/runs/32611271403).
Основной CI не затронут, но история скорости теряется именно на нормальном
cancel-in-progress сценарии. Observer должен записывать bounded anomaly signal,
а не падать целиком.

### Release status в документации уже немного отстал

В таблице lifecycle
[`executable-capabilities.md`](../architecture/executable-capabilities.md)
`quality.gate-runner` всё ещё отмечен как `Released: No`, хотя он вошёл в
0.17.0. Несколько строк documentation index также продолжают описывать RC или
pending qualification после стабильного release. Это не runtime defect, но для
Foundation документация является операторским интерфейсом, поэтому release-state
drift надо исправлять в том же release closure.

## Сильные стороны, которые нельзя потерять

- Foundation не является production runtime dependency и не присваивает себе
  business facts consumers.
- Две publishable packages имеют одностороннее направление: Docs Protocol ->
  Foundation. Reverse manifest, source и policy paths проверяются тестом.
- Каждый capability является отдельным feature slice с model, policies, ports,
  adapters, contract и composition, когда сложность этого требует.
- Consumer configuration data-only; executable plugins и runtime discovery
  отсутствуют.
- Deterministic sorting, strict schemas, immutable evidence, CAS, identity-bound
  journals и fail-closed recovery являются системными инвариантами.
- Release boundary защищён public API baselines, Changesets, packed consumers,
  hermetic registry E2E и provenance.
- 137 test files распределены через fail-closed manifest; stateful recovery tests
  изолированы внутри shard.
- `check:changed`, `check:fast`, параллельный hosted CI и advisory performance
  дают нормальный путь от быстрого feedback к полному evidence.

## Как Foundation безопасно использует Foundation

Цикла package dependencies сейчас нет. Есть два разных графа:

```text
Package graph
  @agent-teams/docs-protocol -> @agent-teams/engineering-foundation

Bootstrap execution graph
  pnpm + TypeScript compiler
    -> build current Foundation source
      -> run current built Foundation checks against this repository
        -> packed/registry qualification
        -> published-version compatibility oracle
```

Private root workspace является composition host, а не публикуемой библиотекой.
Его `workspace:*` devDependency создаёт локальную ссылку на current source; код
Foundation не импортирует собственный npm package. Root сначала вызывает
`tsc --build`, и только после этого использует свежий `dist/cli.js` через
`foundation:check`, `check:changed` и `quality:gate:fast`.

Предыдущая опубликованная версия нужна как compatibility oracle и как exact
recovery authority для evidence, созданного той версией. Она не должна управлять
проверкой текущего source. Иначе публикация новой версии зависела бы от уже
опубликованной новой версии.

Инварианты self-dogfooding:

1. compiler/package-manager bootstrap не зависит от Foundation CLI;
2. Foundation source никогда не зависит от Docs Protocol;
3. current-source checks запускаются только после успешного build;
4. registry и previous-release checks идут после source checks и не подменяют их;
5. recovery всегда следует exact recorded package/build identity.

Отдельный bootstrap package сейчас не нужен.

## Поэтапный roadmap без overengineering

### Этап 0: доказать deployable stable rollout - завершён

Выполнены два authority hardening PR, Docs Protocol patch release, Orchestrator
canary/promotion и последовательный rollout остальных real consumers.

1. Docs Protocol 0.1.1 содержит exact RC3 direct target bundle и пустой
   `rollback_to` для stable Cohort.
2. Base-owned semantic verifier проверяет central projection, canonical
   route/scripts digests и content-addressed historical bytes.
3. Orchestrator доказал RC3 -> stable plan/apply и hosted default-branch gate;
   Cohort прошёл CANARY -> RECOMMENDED.
4. Остальные real consumers обновлены последовательно, каждый с hosted
   default-branch evidence и central bind.
5. Nominal V1 rollback не используется; lifecycle остаётся fix-forward.

### Этап 1: закрыть быстрый operational drift

Ориентир: 50-130 изменённых строк, два маленьких PR.

1. Синхронизировать lifecycle/index с фактом стабильного release.
2. На отрицательную GitHub duration записывать anomaly с `durationMs: null` или
   bounded zero и сохранять весь остальной CI artifact; добавить fixture
   cancelled job.

### Этап 2: декомпозировать recovery до следующего semantic change

Ориентир: 1,500-3,000 изменённых строк в 3-4 PR, включая тесты.

1. Считать текущие journal/envelope/receipt bytes и characterization fixtures
   неизменяемой golden baseline.
2. Извлечь pure transition classification из Node adapter.
3. Отделить identity-bound evidence observation от effect execution.
4. Оставить один тонкий orchestrator; после каждого extraction сравнивать все
   existing crash/recovery post-states и exact serialized evidence.

Не объединять document, scaffold и known-file recovery в универсальный engine:
их wire contracts и причины изменения различаются.

### Этап 3: улучшить diagnostics единым маленьким mapper

Ориентир: 180-350 изменённых строк.

Ввести внутренний `classifyUnexpectedFailure(error, phase)` и использовать его
в check runner/capability modules. Не менять успешные reports и не экспортировать
raw causes.

### Этап 4: завершить coverage migration по evidence, а не по календарю

Ориентир: 80-180 изменённых строк после накопления parity history.

После серии репрезентативных exact-head runs сравнить measured universe и floors.
Только затем сделать partitioned merge blocking и удалить повторный legacy
coverage run. Абсолютные timing budgets оставить advisory.

### Этап 5: сузить public API в ближайшем осмысленном major

Ориентир: 300-800 изменённых строк плюс consumer migrations.

Сначала измерить реальные imports в двух consumers. Qualification helpers
перенести в отдельные qualification exports, concrete Node adapters скрыть за
stable use cases. Не делать major только ради эстетики.

### Этап 6: улучшать contract/adapter placement по мере изменения slices

Ориентир: 200-500 строк на затронутый capability.

Новый или изменяемый capability получает pure mapping/validation отдельно от
filesystem loader и injectable ports с `createDefault...()` composition.
Старые стабильные slices не переписываются массово.

## Итоговая рекомендация

Сохранять текущую двухпакетную модульную архитектуру, закрытый opt-in capability
registry и source-built self-dogfooding. Не строить plugin platform, отдельный
bootstrap package или универсальный recovery engine.

Foundation уже можно масштабировать новыми независимыми feature slices и
подключать новые consumer repositories к доказанному stable Cohort. Новую
recovery semantics не добавлять, пока behaviour-preserving decomposition не
уменьшит оставшийся P1. После rollout максимальный эффект дают recovery
extraction, bounded diagnostics и устранение шума CI observer, а не новый слой
governance.
