import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyFontScale, applyTheme, storedFontScale, storedTheme } from './theme'
import './styles.css'

// 先套配色与字号再渲染，避免启动瞬间闪一下默认黑色 / 默认字号
applyTheme(storedTheme(), false)
const font = storedFontScale()
applyFontScale(font.ui, font.chat, false)

const root = document.getElementById('root')
if (!root) throw new Error('缺少 root 节点')
createRoot(root).render(<App />)
