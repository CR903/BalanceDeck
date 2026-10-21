# 端：agents

AI 协作纪律。

## guides

| 文档 | 说明 | 来源 |
|------|------|------|
| [uitest-command-map.md](guides/uitest-command-map.md) | QA 命令映射：test:* 脚本与被测目标对照表、smoke/uitest/shots 三模式入口 | UI/QA 验证工作流 |

| 知识 | 一句话 |
|---|---|
| [uitest-timing](guides/uitest-timing.md) | uitest 断言只许「等条件成立」（一个轮询实现 + 负向等满预算 + 失败带现场），否则 flaky 的红会被当成新引入的 bug |

## best-practices

| 知识 | 一句话 |
|---|---|
| [subagent-verify](best-practices/subagent-verify.md) | 子代理报的「已完成」必须三样都对上才算数 |
