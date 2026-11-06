# omp-voice

在 OMP 中按 **F8** 朗读最后一条完整回复, 再按一次停止. 支持中文音色选择与试听, 通过阿里云 Token Plan 的语音合成接口生成音频, 在 macOS 本地播放.

这是文字转语音 (TTS) 插件, **不是麦克风录音或语音输入插件**. GitHub 仓库名为 `omp-voice`, OMP 内的包名保留为 `omp-read-aloud`, 插件显示名称为 "按需朗读".

## 功能

- F8 开始朗读或停止当前朗读.
- `/read-aloud` 提供与 F8 相同的操作, 适合 F8 被系统快捷键拦截的终端.
- `/read-aloud-voice` 选择音色, 试听或保存为默认音色.
- 长回复按句末和长度切分, 逐段合成并播放.
- 切换会话, 分支, 会话树或退出时取消当前朗读.

插件只读取当前分支中最后一条正常完成的 assistant 回复文本, 不自动朗读所有新消息, 不朗读 reasoning 或工具结果.

## 环境要求

- macOS, 使用系统 `/usr/bin/afplay` 播放 WAV.
- OMP 与 Bun. 源码使用 OMP 扩展 API 和内置模块, 没有额外运行时依赖.
- `omp` 在 OMP 进程继承的 `PATH` 中可执行, 子进程继承当前 profile 的选择.
- 可以调用下述 TTS 接口的阿里云 **Token Plan 套餐密钥**, 前缀为 `sk-sp-`. 普通其他产品的 API Key 不一定适用.
- 能够访问阿里云接口及其返回的北京 OSS 音频地址.

## 安装

```sh
git clone https://github.com/raiscui/omp-voice.git
cd omp-voice
omp plugin link "$PWD"
```

命名 profile 请通过实际使用的启动器链接, 例如:

```sh
omp4 plugin link /absolute/path/to/omp-voice
```

安装后启动新的 OMP 进程以加载扩展. 不要同时加载旧副本和本仓库副本, 以免重复注册 F8.

### 配置密钥

插件只从 OMP 进程环境中读取 `DASHSCOPE_API_KEY`, 不读取其他项目的私有文件, 不包含内置密钥.

```sh
cp .envrc.example .envrc
```

在本机 `.envrc` 中设置你自己的 `DASHSCOPE_API_KEY`. 使用 direnv 时执行 `direnv allow`, 或在启动 OMP 前显式加载:

```sh
source /absolute/path/to/omp-voice/.envrc
omp
```

`.envrc` 不会由插件自动加载. 请在启动 OMP 的 shell 中加载, 仅在另一个终端设置变量不会影响已运行的 OMP. `.envrc` 与私有变体已忽略, `.envrc.example` 只提供空默认值, 不要把真实密钥写入源码, README 或提交历史.

## 使用

1. 等待 OMP 完成一条回复.
2. 按 F8 开始朗读. 部分 Mac 键盘需要按 `Fn+F8`, 也可以输入 `/read-aloud`.
3. 再按 F8 或执行 `/read-aloud` 停止. 网络请求会取消, 正在播放的进程也会停止.
4. 输入 `/read-aloud-voice`, 选择音色后选择 "试听" 或 "设为默认音色".

没有可朗读的完整回复时会提示, 不发送合成请求. 音色选择需要交互界面. 如果项目配置覆盖全局默认音色, 保存全局设置后会显示实际生效的音色提示.

也可以使用 OMP 的配置命令:

```sh
omp plugin config get omp-read-aloud voice --json
omp plugin config set omp-read-aloud voice longanlingxin
```

命名 profile 使用对应启动器, 例如 `omp4 plugin config get omp-read-aloud voice --json`.

### 可选音色

| 名称 | ID |
| --- | --- |
| 龙安灵心 (默认) | `longanlingxin` |
| 龙安鲁风 | `longanlufeng` |
| 龙山焰灿 | `qwen-audio-3.0-tts-plus-longshanyancan` |
| 龙鹰逸帆 | `qwen-audio-3.0-tts-plus-longyingyifan` |
| 龙朗虹沫 | `qwen-audio-3.0-tts-plus-longlanghongmo` |
| 龙蓉芷荷 | `qwen-audio-3.0-tts-plus-longrongzhihe` |
| 龙璨竹月 | `qwen-audio-3.0-tts-plus-longcanzhuyue` |
| 龙安欢 | `longanhuan_v3.6` |

实际可用音色以服务端对当前套餐和模型的支持为准.

## 数据流, 隐私与费用

- 按 F8 或试听后, 待朗读文本会发送至阿里云服务, 使用 `qwen-audio-3.0-tts-plus` 模型. 这是云端合成, 不是离线朗读, 可能消耗套餐额度或产生费用.
- 固定接口为 `https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`.
- 密钥仅用于该合成请求的 Bearer 认证, 不附加到音频下载请求.
- 音频下载只接受 `.oss-cn-beijing.aliyuncs.com` 子域名, 使用 HTTPS, 并检查返回内容的 WAV 文件头.
- 生成的 24 kHz WAV 暂存在系统临时目录 `omp-read-aloud-*`, 文件权限为 `0600`, 每段播放结束或出错后清理. 进程被强制终止时可能留下临时文件.
- 合成请求超时为 120 秒, 下载超时为 60 秒. 失败会显示错误, 不进行自动重试或更换服务.

不要朗读不允许发送到云端的内容. 本仓库不收录 API Key, 用户回复, 合成音频或个人配置.

## 排障

| 现象 | 检查项 |
| --- | --- |
| F8 没反应 | 当前 profile 是否加载插件, 是否被系统媒体键拦截; 尝试 `/read-aloud` |
| 提示没有可朗读的完整回复 | 等待一条正常完成的 assistant 回复, 当前分支可能尚无符合条件的内容 |
| 提示密钥无效 | 确认 OMP 启动时继承了 `DASHSCOPE_API_KEY`, 且为 `sk-sp-` 套餐密钥 |
| HTTP 401/403 或其他合成错误 | 核对密钥权限, 套餐, 模型和音色可用性 |
| 插件设置操作失败 | 检查 `omp` 是否在 PATH 中, 当前 profile 是否安装 `omp-read-aloud` |
| 下载或播放失败 | 检查网络, OSS 地址兼容性和 macOS 音频输出设备 |

## 开发说明

`read-aloud.ts` 是扩展入口, `package.json` 声明音色枚举及默认值. 保持包名 `omp-read-aloud` 是为了让配置命令与插件身份一致, 不要求仓库名相同.

发布整理移除了原本机副本中对特定私有项目凭据路径, `~/.bun/bin` 安装路径和 `codex4` profile 的硬编码. 本仓库使用环境变量和 `PATH` 中的 OMP, 不会修改已安装的旧副本或自动迁移它的配置.

## 卸载

```sh
omp plugin uninstall omp-read-aloud
```

命名 profile 使用对应启动器. 已加载的扩展会在该 OMP 进程退出后停止运行. 卸载不会撤销云服务密钥或清理你自行保存的本机凭据.
