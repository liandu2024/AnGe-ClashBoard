# AnGe-ClashBoard

![AnGe-ClashBoard 首图](readme/hero.png)

AnGe-ClashBoard 是一个基于 `Vue 3 + TypeScript + Vite` 的 Clash 面板，面向 `Clash API`、`Mihomo`、`OpenClash`、`Nikki` 和 `sing-box` 的运行态管理、观测与排错。

当前版本为 `1.41`，基于开源 [zashboard](https://github.com/Zephyruso/zashboard) 二次开发。

## 教学视频

- [YouTube 教学视频](https://youtu.be/J5mdEJQHlG8)

## 相关链接

- [安格超市（代理、VPN、VPS、住宅IP、GPT/流媒体账号）](https://blog.angeworld.cc/market)
- [芝麻开门AI接口（GPT5.4/Claude4.6/Gemini3.1）](https://ai.opendoor.cn)
- [安格视界官方TG群2](https://t.me/angeworld2024_2)

## 项目特点

- 支持 Clash API、Mihomo、OpenClash、Nikki、sing-box
- 支持 SQLite 持久化配置，切换浏览器后仍可保留配置
- 支持背景图服务端持久化
- 支持图标上传、拖拽、复制和预览
- 支持规则缓存、域名/IP/关键字规则查询、链路展示和兜底规则判断
- 支持后端中转控制器数据，公网访问面板时无需直接暴露控制器端口
- 支持 Docker 一键部署，适合个人和局域网环境

## 功能预览

### 策略穿透

![策略穿透](readme/icon-management.png)


策略穿透可以直接展开策略组内部的节点和子策略链路，便于快速查看当前命中策略、候选节点状态和最终出口。

### 规则穿透

![规则穿透](readme/strategy-penetration.png)

规则穿透支持按域名、IP 和关键字查询规则命中结果，并展示规则来源、匹配类型、策略链路和最终节点，方便排查分流问题。

### 图标管理

![图标管理](readme/rule-penetration.png)


图标管理支持自定义图标映射、上传、复制和删除，可分别为策略组、节点组和其他项目配置专属图标。

## 一键安装

默认端口：`2048`

```bash
curl -fsSL https://raw.githubusercontent.com/liandu2024/AnGe-ClashBoard/main/scripts/install.sh | bash
```

## 自定义端口部署

例如部署到 `8080`：

```bash
curl -fsSL https://raw.githubusercontent.com/liandu2024/AnGe-ClashBoard/main/scripts/install.sh | bash -s -- 8080
```

## 无损升级

升级会保留现有数据目录，不会删除你的配置、背景图和规则缓存。

```bash
curl -fsSL https://raw.githubusercontent.com/liandu2024/AnGe-ClashBoard/main/scripts/update.sh | bash
```

## 彻底卸载

卸载会删除：

- 容器
- 镜像
- `/opt/ange-clashboard`
- 本地数据目录

```bash
curl -fsSL https://raw.githubusercontent.com/liandu2024/AnGe-ClashBoard/main/scripts/uninstall.sh | bash
```

## Docker 运行

推荐直接使用已发布到 GHCR 的镜像：

```bash
ghcr.io/liandu2024/ange-clashboard:latest
```

已发布镜像支持 `linux/amd64`、`linux/arm64` 和 `linux/arm/v7`。

手动运行：

```bash
docker run -d \
  --name ange-clashboard \
  -p 2048:2048 \
  -v ./data:/app/data \
  ghcr.io/liandu2024/ange-clashboard:latest
```

健康检查：

```bash
http://127.0.0.1:2048/api/health
```

## 服务端持久化

项目内置轻量 Node 服务，用于保存：

- 设置
- 背景图
- 规则缓存

默认数据库路径：

```bash
./data/zashboard.sqlite
```

可通过环境变量覆盖：

```bash
ZASHBOARD_DB_PATH
```

## 规则查询

规则页支持按域名查询命中的规则来源，并展示实际策略链路。

当前支持：

- 文本规则源缓存
- `.mrs` 域名规则集解析
- 规则顺序排序
- 兜底规则检测
- 根据 YAML 中的 `interval` 自动更新缓存
- 刷新规则时显示累计规则数量与手动停止

规则源默认读取：

```bash
data/rule-source.yaml
```

也可通过环境变量覆盖：

```bash
ZASHBOARD_RULE_SOURCE_PATH
```

## 项目结构

- `src/`：前端代码
- `server/`：本地持久化与规则缓存后端
- `data/`：运行时数据目录
- `public/`：静态资源
- `scripts/`：安装、升级、卸载脚本
- `readme/`：README 展示图片

## 授权

本项目基于上游 `zashboard` 二次开发。上游使用 `MIT License`，因此你可以在保留原许可证声明的前提下继续修改、发布和分发。

请保留仓库中的 [LICENSE](LICENSE) 文件。

## 致谢

- 上游项目：[zashboard](https://github.com/Zephyruso/zashboard)
- Clash / Mihomo / sing-box 生态项目与规则集作者

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=liandu2024/AnGe-ClashBoard&type=Date)](https://www.star-history.com/#liandu2024/AnGe-ClashBoard&Date)
