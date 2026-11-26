# 读文档（含扫描件）

她在聊天里遇到附件时，用 `stellar_file_read` 取正文：本机路径、URL、合并转发里的文件都能读。
这一页说清「能读什么」和「读不了的时候为什么不读」，避免你以为她偷懒。

## 一、支持的格式

| 格式 | 怎么读 | 备注 |
| --- | --- | --- |
| PDF | 内嵌 pdfjs 抽文字层；**没有文字层就自动 OCR** | 见第二节 |
| docx / xlsx / pptx | 自己解 OOXML（不依赖 Office） | 表格按行取、演示按页取 |
| doc / xls / ppt / wps / et / dps | 交给本机已装的 WPS 或 Office 转成 OOXML 再读 | 没装就明确报「本机的 WPS / Office 没能转换它」 |
| csv / txt / md / rtf / html | 直接解码（自动认 UTF-8 / UTF-16 / GBK） | — |
| 老式压缩包 | 明确拒绝 | 「这是一个压缩包，我没法直接读里面的内容」 |

单文件上限：**PPT/PPTX 等演示文稿 256 MB**（一整本宣讲/课件动辄 100MB+，体积基本都在图里），其余文档 60 MB；整本文档会先抽全文（最多 40 万字），模型只看开头，细节用 `stellar_spill_read` 分段读。

演示文稿放宽的边界：`.pptx` / `.ppt` / `.dps` / `.odp`；PDF / Word / Excel 仍是 60 MB。超过上限时她会直说「文件太大」和具体上限，不会猜内容。

## 二、扫描件与纯图片 PDF

很多「扫描件」PDF 里其实没有文字，只有图片。这种情况会自动走 **Windows 自带 OCR**：

1. `Windows.Data.Pdf` 把每页渲染成位图（默认宽 2200 px）；
2. `Windows.Media.Ocr` 认字（优先 `zh-Hans-CN`，中英混排都能认）；
3. 结果按页拼回正文，并在返回的「说明」里写明这是 OCR 认出来的、个别字可能有误。

要点：

- **不需要装 tesseract、也不需要 Office 或会员**：用的是系统组件。
- 只有「几乎没有文字层」的 PDF 才会 OCR（去掉页眉标记后平均每页不足 5 个字）。
  有文字层的 PDF 哪怕只有一行字也不会白花两秒去 OCR。
- 耗时约 0.5–1 秒/页，所以默认只认前 30 页。
- PowerShell 那一侧经常以 `0xC0000005` 退出，那是 WinRT 收尾的老毛病；判定只看输出文件，不看退出码。

## 三、读不了的时候会说什么

| 情况 | 她得到的回复 |
| --- | --- |
| PDF 有文字层 | 正常正文 |
| PDF 无文字层、OCR 成功 | 正文 + 「扫描件：文字是系统 OCR 认出来的」 |
| PDF 无文字层、OCR 也认不出 | 「这个 PDF 没有文字层，OCR 也没认出字：<原因>」 |
| 缺 pdfjs（没执行过 `npm install`） | 「PDF 解析组件加载失败（缺 pdfjs-dist：项目根目录跑一次 npm install）」 |
| 老版 Office 且没装 WPS/Office | 「本机的 WPS / Office 没能转换它」 |

## 四、安全边界

- 本地路径必须落在工作区 / `~/.dsh/stellar` / 临时目录内，软链按真实路径校验；
- URL 必须过公网白名单（挡 SSRF，含「域名解析到 127.0.0.1」这种绕法）；
- 密钥类文件（`.credentials*`、`panel-token*`、`*.pem`、`*.key`、`id_rsa*`、`.env*`）一律拒读。

详见 [SECURITY_BASELINE.md](../operations/SECURITY_BASELINE.md)。