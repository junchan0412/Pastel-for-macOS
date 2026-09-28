感谢你使用 Pastel！

Pastel 20260928.3 更新内容：

1. 修复「首次购买指定版本」的三处问题：
   - 补上 Apple 的 updateProduct 与 backgroundUpdateProduct 兜底端点（参考 majd/ipatool 与 IPA-Tool-3.0），此前指定的历史版本在前两个端点返回空时会被误判成「该版本暂不可取」，普通下载也可能误报取不到数据。
   - 许可检查改为按账户整体判断（不绑定版本），并把 Apple 返回的「空数据」识别为未拥有，此前这类 App 会直接报错、走不到购买这一步。
   - 修正购买结果判定在日语、韩语、泰语下的误判（改由成功类型直接给出，不再靠文案关键词猜）。
2. 购买后校验更稳健：认证过期自动重新登录重试，Apple 明确提示版本不可用时立即结束，其余情况继续轮询，避免刚买到许可就误报失败。
3. 购买成功后界面区分更清楚：蓝勾表示指定版本已可下载，橙色感叹号表示许可已拿到但该版本暂不可取。

本安装包未使用 Apple 开发者证书签名与公证，首次打开需放行 Gatekeeper（右键 → 打开，或执行 `xattr -dr com.apple.quarantine /Applications/Pastel.app`）；自动更新由 Sparkle 的 EdDSA 签名保护，与 Apple 证书无关。

Pastel-20260928.3-build-2026092805.dmg SHA-256：`0a58c4def63e80e76aeb7ef4cffd7356e4690b0a86c39803e6c841b0d818d3cd`
