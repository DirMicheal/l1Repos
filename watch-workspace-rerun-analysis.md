# Vitest Watch 模式 · Workspace Rerun 链路解析

> 范围:`packages/vitest/src/node/{stdin,watch-filter,watcher,core}.ts` 以及 `test/e2e/test/watch/workspaces.test.ts`,
> 配合证实链路的 `project.ts`、`plugins/index.ts`、`reporters/base.ts`、`specifications.ts`、`config/resolveConfig.ts`。
> 目的:讲清 watch 模式下 `t` / `p` / `w` 三类键盘交互如何变成「筛选条件 → 项目过滤 → rerun 目标」,workspace 场景下哪些状态是全局、哪些是按项目,现有测试怎么覆盖这条链路,以及后续排查该从哪儿入手。
> 所有引用均为 `文件:行号`,可直接点击跳转。

---

## 0. 一张图看懂

```
键盘                stdin.ts                      core.ts (Vitest 实例)                  作用域
────────────────────────────────────────────────────────────────────────────────────────────
 t  ─► inputNamePattern() ─► WatchFilter        ─► changeNamePattern()
                            (getFilteredTestNames)   └─ configOverride.testNamePattern = /…/   全局
                                                      └─ rerunFiles() ─► runFiles()
 p  ─► inputFilePattern() ─► WatchFilter         ─► changeFilenamePattern()
                            (globTestSpecifications)  └─ this.filenamePattern = [...]            全局(rerun 闸门)
                                                      └─ rerunFiles() ─► runFiles()
 w  ─► inputProjectName() ─► prompts(无补全)     ─► changeProjectName()
                                                      └─ configOverride.project = [name]        全局
                                                      └─ vite.restart()  ──► 重新 _setServer()  重建 projects 集合

文件保存(非键盘) ─► VitestWatcher.onFileChange/onFileCreate/onFileDelete
                       └─ handleFileChanged()  (逐 project 遍历 module graph / importers)        按项目
                       └─ handleSetupFile()    (逐 project 匹配 setupFiles)                      按项目
                       └─ changedTests.add(...) ─► scheduleRerun() ─► runFiles()                 全局集合
```

核心一句话:**`t`/`p`/`w` 三类筛选条件本身都是「全局」的**(挂在 `Vitest` 实例 / `configOverride` 上,对所有 project 生效);**「按项目」只发生在两个地方**——(1) 收集/执行时每个 project 各自套用这份全局配置;(2) 文件变更时 watcher 逐 project 判断「这个文件归哪些 project、要重跑哪些 project 的测试」。

---

## 1. 共享入口:`registerConsoleShortcuts` 与按键分发

`registerConsoleShortcuts(ctx, stdin, stdout)`(stdin.ts:73)在启动 watch 时注册一次,内部 `on()`/`off()` 负责 readline 的 raw-mode 挂载与卸载(stdin.ts:239-256)。

- 快捷键表 `keys`(stdin.ts:13-22)定义了 `t`/`p`/`w` 的语义:
  - `p` → *filter by a filename*
  - `t` → *filter by a test name regex pattern*
  - `w` → *filter by a project name*
- `_keypressHandler`(stdin.ts:80-153)是总分发:
  - 运行中按键 → 若命中 `cancelKeys`(stdin.ts:23,含全部快捷键)则取消当前 run(stdin.ts:108-113);
  - `w` → `inputProjectName()`(stdin.ts:142-144)
  - `t` → `inputNamePattern()`(stdin.ts:146-148)
  - `p` → `inputFilePattern()`(stdin.ts:150-152)
  - 另外:`a`/`return` → `changeNamePattern('', files, 'rerun all tests')`、`r` → `rerunFiles()`、`f` → `rerunFailed()`、`u` → `updateSnapshot()`(stdin.ts:129-140)。

### `WatchFilter`:`t` 和 `p` 共用的「带自动补全的输入框」

`WatchFilter`(watch-filter.ts:20)是一个交互式过滤器:`filter(filterFunc)`(watch-filter.ts:49)在每次按键后调用 `filterFunc(currentKeyword)` 拿到候选列表并渲染(watch-filter.ts:126-130),回车时返回「选中项的 `key`」或「当前输入串」(watch-filter.ts:86-97)。

- `t` 用泛型 `'object'`:候选项是 `{ key, toString }`,`key` 是测试名、`toString` 是 `父级 > 测试名` 的展示串(stdin.ts:41-54)。
- `p` 用默认 `'string'`:候选项就是相对路径字符串。
- `getLastResults()`(watch-filter.ts:242-244)把最后一次候选列表交回给 `p` 用作 rerun 的文件清单。

> 注意:`w` **不**走 `WatchFilter`,而是用 `prompts` 库的单行文本输入(stdin.ts:190-202),**没有自动补全**,默认值取 `ctx.config.project[0]`。

---

## 2. `t` —— 按测试名正则过滤(全局 testNamePattern)

### 2.1 输入 → 筛选条件
`inputNamePattern()`(stdin.ts:159-188):
1. `off()` 摘掉全局按键监听,创建 `WatchFilter<'object'>`。
2. `watchFilter.filter(str => [...getFilteredTestNames(str, ctx.state.getFiles())])`(stdin.ts:166-168):
   - `getFilteredTestNames(pattern, suite)`(stdin.ts:56-71):用 `new RegExp(pattern)` 在 **`ctx.state.getFiles()`(全局、跨所有 project 的已收集文件)** 上遍历,`traverseFilteredTestNames` 对名字匹配的 test 产出 `{ key: t.name, ... }`(stdin.ts:41-54)。
   - ⚠️ **已知限制(stdin.ts:59)**:`// TODO: we cannot run tests per workspace yet: filtering files`,并且这里按 `file.name` 去重(stdin.ts:60-66)——workspace 下不同 project 跑「同名文件」会在候选层被折叠。
3. 取消则直接返回(stdin.ts:172-174)。非 standalone 时 `cliFiles` 为 `undefined`(stdin.ts:176-181)。
4. `ctx.changeNamePattern(filter.trim() || '', cliFiles, 'change pattern')`(stdin.ts:183-187)。

### 2.2 筛选条件 → rerun 目标
`Vitest.changeNamePattern(pattern, files, trigger)`(core.ts:1283-1303):
- pattern 为空 → 顺带把 `this.filenamePattern` 置空(core.ts:1285-1287),即**清空测试名 pattern 会同时清空文件名 pattern**。
- **`this.configOverride.testNamePattern = pattern ? new RegExp(pattern) : undefined`(core.ts:1289-1290)** —— 这是全局开关。
- 先把 `files`(默认 `this.state.getFilepaths()`)收窄成「含有匹配 test 的文件」(core.ts:1292-1300),再 `rerunFiles(files, trigger, pattern === '')`(core.ts:1302)。

### 2.3 为什么是「全局」:override 怎么下发到每个 project
每个 project 发给 worker 的配置由 `serializedConfig`(project.ts:227-229)→ `_serializeOverriddenConfig()`(project.ts:676-686)产生,关键是:

```ts
return deepMerge(serializeConfig(this), this.vitest.configOverride)  // project.ts:682-685
```

即**每个 project 的最终配置 = 自己的 config 深合并全局 `configOverride`**。因此 `configOverride.testNamePattern` 会原样覆盖到**所有** project——`t` 的过滤天然是全局的,没有「只过滤某个 project 的测试名」这一档。reporter 里 `Test name pattern: /…/` 也是直接读 `configOverride.testNamePattern` 打印(reporters/base.ts:469-470)。

---

## 3. `p` —— 按文件名过滤(全局 filenamePattern 闸门)

### 3.1 输入 → 筛选条件
`inputFilePattern()`(stdin.ts:204-236):
1. `WatchFilter`(string 模式),`filterFunc` 调 `ctx.globTestSpecifications([str])`(stdin.ts:213-219)——**跨所有 project** glob 出匹配的测试文件,映射成相对 `ctx.config.root` 的路径并去重。
2. `latestFilename = filter.trim()`,`lastResults = watchFilter.getLastResults()`(stdin.ts:227-228)。
3. `ctx.changeFilenamePattern(latestFilename, 有结果 ? lastResults 映射成绝对路径 : undefined)`(stdin.ts:230-235)。

### 3.2 筛选条件 → rerun 目标
`Vitest.changeFilenamePattern(pattern, files)`(core.ts:1306-1312):
- **`this.filenamePattern = pattern ? [pattern] : []`(core.ts:1307)** —— 挂在实例上的全局字段(声明见 core.ts:118)。
- `rerunFiles(files, trigger, pattern === '')`(core.ts:1311)。

### 3.3 `filenamePattern` 是「rerun 闸门」
这个字段在两处充当过滤闸:
- **手动 rerun**:`rerunFiles`(core.ts:1221-1240)里若 `filenamePattern` 存在,会 `globTestSpecifications(this.filenamePattern)` 后与待跑文件取交集(core.ts:1226-1229)。
- **文件保存触发的 rerun**:`scheduleRerun`(core.ts:1423-1431)里同样用 `filenamePattern` 过滤 `changedTests`,**若某次变更的文件不在 pattern 内,直接 `return` 不重跑**(core.ts:1428-1430)。

因为 glob 跨所有 project,所以 `p` 的文件名 pattern 也是**全局**的:一个 pattern 可以同时匹配多个 project 的文件,Vitest 不区分这些文件分属哪个 project。

---

## 4. `w` —— 按项目名过滤(全局 project 过滤 + 整体重启)

`w` 与 `t`/`p` 本质不同:**它改变的是「哪些 project 被加载」,并通过整体重启生效**。

### 4.1 输入 → 筛选条件
`inputProjectName()`(stdin.ts:190-202):用 `prompts` 单行输入(默认值 `ctx.config.project[0]`,无补全),`ctx.changeProjectName(filter.trim())`(stdin.ts:201)。

### 4.2 筛选条件 → 项目过滤 → rerun
`Vitest.changeProjectName(pattern)`(core.ts:1271-1280):
- 空 → `configOverride.project = undefined`;否则 → `configOverride.project = [pattern]`(单元素数组)。
- **`await this.vite.restart()`(core.ts:1279)** —— 触发整体重启。

重启路径:`_setServer`(core.ts:237)在 watch 下劫持了 `server.restart`(core.ts:309-315),会 `close()` → `serverRestart()` → 再次 `_setServer`。重启时:
- `this.projects = []`、`coreWorkspaceProject = undefined`、清各类缓存(core.ts:244-247),但 **`configOverride` 不被重置**(它只由 `change*` 方法改写),所以 `configOverride.project` 跨重启存活。
- 插件层读取它当过滤器:`if (vitest.configOverride.project) { options.project = vitest.configOverride.project }`(plugins/index.ts:164-166)。
- `resolveProjects(this._cliOptions)`(core.ts:337,实现 575-599)据此只解析匹配的 project,`matchesProjectFilter`/`isExcludedByProjectFilter`(core.ts:1666-1691)读的就是 `this._config?.project || this._cliOptions?.project`。
- 结果:**只有匹配 `w` 的 project 才会进入 `this.projects` 并建起各自的 Vite server**,其余 project 连 server 都不创建。这就是 `w` 必须重启、且是全局的根本原因——project 集合在 server/插件 setup 时就定死了。
- reporter 里 `Project name: …` 同样读 `configOverride.project`(reporters/base.ts:461-462)。

---

## 5. 文件保存触发的 rerun(非键盘):按项目判断的关键所在

键盘交互之外,真正体现「workspace 按项目处理」的是文件系统 watcher。

### 5.1 `VitestWatcher` 的入口与全局集合
`VitestWatcher`(watcher.ts:8)持有两个**全局**集合:
- `invalidates: Set<string>`(watcher.ts:12)——下次运行要失效的模块。
- `changedTests: Set<string>`(watcher.ts:16)——已变更、需要重跑的测试文件。

`registerWatcher`(watcher.ts:38-56)挂上 `change`/`unlink`/`add` 三个事件:
- `onFileChange`(watcher.ts:84-98):`invalidateFile` → `getTestFilesFromWatcherTrigger`(watchTriggerPatterns,watcher.ts:62-82)→ 否则 `handleFileChanged`,需要则 `scheduleRerun`。
- `onFileDelete`(watcher.ts:100-113):从 `state.filesMap`、各 project 缓存、`changedTests` 中删除,并 `report('onTestRemoved')`。
- `onFileCreate`(watcher.ts:115-145):逐 project 调 `project.matchesTestGlob(id, …)`(watcher.ts:128-132)判断新文件归属;**有匹配 project 才加入 `changedTests` 并重跑**(watcher.ts:134-137)。

### 5.2 `handleFileChanged`:逐 project 遍历 module graph(跨项目 rerun 的核心)
`handleFileChanged(filepath)`(watcher.ts:171-239)是「改了一个文件要重跑哪些测试」的大脑:
1. 已在 `changedTests`/`invalidates` 则跳过(watcher.ts:172-174)。
2. 命中 `forceRerunTriggers` → 把**所有**已知测试文件加入 `changedTests`(watcher.ts:176-179)——全局强制重跑。
3. `handleSetupFile`(见 5.3)。
4. **逐 project** 用 `project._getViteEnvironments().moduleGraph` 找出引用了该文件的 project(watcher.ts:185-189);
5. 对每个相关 project:若该文件本身是其测试文件 → 直接加入;否则**沿 importers 递归** `handleFileChanged(i.file)`(watcher.ts:202-235),把引用它的测试文件挖出来。

> 这正是「一个源文件被多个 workspace 引用时,两个 project 的测试都会重跑」的实现:同一个 `math.ts` 在 `space_1` 和 `space_3` 的 module graph 中都能找到,importer 遍历分别命中两个 project 的测试文件。

### 5.3 `handleSetupFile`:逐 project 匹配 setupFiles
`handleSetupFile(filepath)`(watcher.ts:147-166):**逐 project** 检查 `project.config.setupFiles` 是否包含该文件;命中后只把 `file.projectName === project.name` 的测试文件加入 `changedTests`(watcher.ts:155-162)。即 setup 文件的影响**严格限定在拥有它的 project**。

### 5.4 `scheduleRerun`:debounce、闸门与扇出
`Vitest.scheduleRerun`(core.ts:1395-1452)是 watch rerun 的心脏(`WATCHER_DEBOUNCE = 100ms`,core.ts:61):
- `changedTests` 为空则清 `invalidates` 返回(core.ts:1408-1411)。
- **`filenamePattern` 闸门**:用它过滤 `changedTests`,全被滤掉则 `return`(core.ts:1423-1431)——`p` 的过滤在这里再次生效。
- `files.flatMap(file => this.getModuleSpecifications(file))`(core.ts:1437)——**扇出点**:一个文件 → 一到多个 `TestSpecification`(workspace 下同一路径若被多 project include,会得到多个 spec,见 specifications.ts:16)。
- 再用 `_onFilterWatchedSpecification`(core.ts:1437-1442)做可选过滤,然后 `runFiles(specifications, false)`(core.ts:1448)。

> 手动键盘路径 `rerunFiles`(core.ts:1221-1240)/`rerunFailed`(core.ts:1315-1317)走的是同一套「`getModuleSpecifications` 扇出 → `runFiles`」,区别只是文件来源和是否重置 pattern。

---

## 6. Workspace 下:全局 vs 按项目 对照表

| 状态 / 行为 | 作用域 | 位置 | 说明 |
|---|---|---|---|
| `configOverride.testNamePattern`(`t`) | **全局** | core.ts:1290;下发 project.ts:682-685 | 深合并进每个 project 的 serializedConfig,所有 project 同一 pattern |
| `this.filenamePattern`(`p`) | **全局** | core.ts:118,1307;闸门 1226-1229 / 1423-1431 | 跨 project glob,既限手动 rerun 也限文件保存 rerun |
| `configOverride.project`(`w`) | **全局** | core.ts:1273-1276;消费 plugins/index.ts:164-166 | 决定哪些 project 被解析进 `this.projects`,改它要 `vite.restart()` |
| `configOverride.snapshotOptions` / `coverage` | **全局** | core.ts:1348-1352 等;下发 project.ts:682-685 | 同样深合并到每个 project |
| `watcher.changedTests` / `watcher.invalidates` | **全局集合** | watcher.ts:12,16 | 文件粒度,元素本身不带 project,扇出靠 `getModuleSpecifications` |
| `state.filesMap` 里的 `File` | 全局存储、**按项目打标** | watcher.ts:155-162 用 `file.projectName` | 同一文件被多 project 跑会有多条记录 |
| 改文件 → 重跑哪些测试 | **按项目** | watcher.ts:185-238 | 逐 project 遍历各自 module graph + importers |
| 新文件归属 | **按项目** | watcher.ts:128-132(`matchesTestGlob`) | 只有 include 命中的 project 接收新文件 |
| setup 文件影响范围 | **按项目** | watcher.ts:147-166(`setupFiles`) | 只重跑拥有该 setup 的 project |
| testNamePattern / 文件名 的「按 project 区分」 | **不支持** | stdin.ts:59 TODO | 没有「只过滤某个 project 测试名/文件名」的入口 |

---

## 7. 现有测试如何覆盖这条链路(`workspaces.test.ts`)

测试用 `runVitestCli`/`runInlineTests` 起真实 watch 进程,靠 `waitForStdout` 断言。逐条映射到代码路径:

| 用例(行号) | 触发 | 覆盖的代码路径 | 验证的「按项目」语义 |
|---|---|---|---|
| 编辑 workspace 内某测试文件重跑(:52-60) | 写 `space_2/.../node.spec.ts` | `onFileChange`→`handleFileChanged`→`changedTests`→`scheduleRerun` | 只有 `space_2` 重跑(窄扇出) |
| 编辑被多 workspace 引用的文件,两个都重跑(:62-71) | 写共享源 `src/math.ts` | `handleFileChanged` 跨 project module graph + importer 遍历(watcher.ts:185-238) | `space_1` 与 `@vitest/space_3` 同时重跑(宽扇出) |
| 在 workspace 内按测试名过滤(:73-84) | `write('t')` → `2 x 2 = 4\n` | `t` 全链:`inputNamePattern`→`getFilteredTestNames`→`changeNamePattern`→全局 `testNamePattern`→rerun | 断言 `Test name pattern: /2 x 2 = 4/`(reporters/base.ts:469)且 `1 passed`——**pattern 全局,但只 1 个文件含匹配 test** |
| 新增匹配核心 project 配置的测试文件(:86-106) | 写 `space_2/.../new-dynamic.test.ts` | `onFileCreate`→`matchesTestGlob`(watcher.ts:128) | 断言**只有** `|space_2|` 跑,其余 project 不跑 |
| 新增匹配 project 专属 include 的测试文件(:108-127) | 写 `space_3/...space-3-test.ts` | 同上,走 project 专属 include | 断言**只有** `|@vitest/space_3|` 跑 |
| 编辑 project 内 setup 文件(:129-168) | `runInlineTests` p1 有 setup、p2 没有,改 `setupFile.js` | `handleSetupFile`(watcher.ts:147-166) | 断言只有 `[p1] reruns`、`[p2]` 不跑 |

**这些测试已经覆盖**:单 project 文件编辑、跨 project 共享源、`t` 全局测试名过滤、新文件按 project 归属(含 project 专属 include)、setup 文件按 project 限定。

**尚未覆盖(后续补测的候选)**:
- `p`(`changeFilenamePattern`)在 workspace 下的行为,尤其 `scheduleRerun` 里 `filenamePattern` 闸门对跨 project 文件的过滤(core.ts:1423-1431);
- `w`(`changeProjectName` + `vite.restart` + 重启后 project 集合收窄,core.ts:1271-1280 / plugins/index.ts:164-166);
- `t` 与 `p` 组合,以及空 `t` 连带清空 `filenamePattern`(core.ts:1285-1287);
- `r`(`rerunFiles`)/`f`(`rerunFailed`)/`a`(rerun all)在 workspace 下的扇出;
- `onFileDelete` 在 workspace 下对 `state.filesMap` 与各 project 缓存的清理(watcher.ts:100-113)。

---

## 8. 后续排查 workspace watch 问题:优先看这些函数 / 数据结构

按「最常出问题 → 入手优先级」排序:

1. **`Vitest.scheduleRerun`(core.ts:1395-1452)** —— 几乎所有「保存后没重跑 / 多跑 / 漏跑」都先看这里:debounce、`filenamePattern` 闸门(1423-1431)、`getModuleSpecifications` 扇出(1437)、`_onFilterWatchedSpecification`(1438-1442)。
2. **`VitestWatcher.handleFileChanged`(watcher.ts:171-239)** —— 「改了源文件,某个 project 的测试没跟着跑」基本都在 module graph / importer 遍历这段;注意 server 重启后 module graph 丢失的兜底分支(watcher.ts:190-198)。
3. **`getModuleSpecifications`(core.ts:902-904 → specifications.ts:16)** —— 文件 → `(project, spec)` 的映射,workspace 扇出是否正确的唯一真相源。
4. **`VitestWatcher.onFileCreate` + `project.matchesTestGlob`(watcher.ts:115-145, 128)** —— 新文件归到哪些 project。
5. **`VitestWatcher.handleSetupFile`(watcher.ts:147-166)** —— setup 文件影响范围是否按 project 收敛。
6. **`Vitest.changeProjectName` + `_setServer` 重启链 + `resolveProjects`/`matchesProjectFilter`(core.ts:1271-1280, 237/309-337, 575-599, 1666-1691;plugins/index.ts:164-166)** —— `w` / `--project` 相关的 project 集合问题。
7. **`Vitest.changeNamePattern` / `changeFilenamePattern`(core.ts:1283-1312)** + **`_serializeOverriddenConfig`(project.ts:676-686)** —— pattern 为何对所有 project 生效、为何空 `t` 会清掉文件名 pattern。

**关键数据结构**:
- `Vitest.configOverride`(core.ts:117)——`testNamePattern`/`project`/`snapshotOptions`/`coverage` 全在这,且**跨重启存活**,深合并进每个 project 的 serializedConfig。
- `Vitest.filenamePattern`(core.ts:118)——全局文件名闸门。
- `VitestWatcher.changedTests` / `invalidates`(watcher.ts:12,16)——文件粒度的全局集合。
- `state.filesMap` 中 `File.projectName`(watcher.ts:155-162)——把全局文件存储与「按项目」语义连起来的字段。

**已知限制 / 易踩坑(排查前先记住)**:
- `stdin.ts:59` 的 TODO:测试名过滤无法做到「按 workspace」,且候选按 `file.name` 去重(stdin.ts:60-66)——多 project 同名文件会被折叠。
- `t`/`p`/`w` 没有「只作用于某个 project」的档位;要按 project 限定只能先用 `w` 收窄 project 集合(且会重启)。
- `w` 走整体重启,代价远高于 `t`/`p`;`t`/`p` 只改 override/字段并 rerun,不重启。
- 空 `t` 会顺带清空 `filenamePattern`(core.ts:1285-1287),排查「文件名过滤莫名失效」时留意是否先按了空的 `t`。
