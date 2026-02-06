# 全站导航与移动端横滑审计（自动巡检）

- 目标基址：https://yuookie.qzz.io
- 生成时间：2026-02-07 02:00:54
- 总问题数：0
- P0：0
- P1：0

## 问题清单

| 严重度 | 类型 | 视口 | 页面 | 目标 | 详情 |
|---|---|---:|---|---|---|

## 运行方式

- 手工巡检：`RUN_E2E_MOBILE=1 pytest tests/e2e_mobile/test_mobile_navigation_audit.py -q`
- 严格门禁：`RUN_E2E_MOBILE=1 E2E_STRICT=1 pytest tests/e2e_mobile/test_mobile_navigation_audit.py -q`
- 线上基址：`RUN_E2E_MOBILE=1 E2E_BASE_URL=https://yuookie.qzz.io pytest tests/e2e_mobile/test_mobile_navigation_audit.py -q`
- 线上带认证：`RUN_E2E_MOBILE=1 E2E_BASE_URL=https://yuookie.qzz.io E2E_HTTP_AUTH=user:pass pytest tests/e2e_mobile/test_mobile_navigation_audit.py -q`

## CI 门禁

- PR Smoke：`.github/workflows/mobile-audit-smoke.yml`
- Nightly 全量：`.github/workflows/mobile-audit-nightly.yml`
