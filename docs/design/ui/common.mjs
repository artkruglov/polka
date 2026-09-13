export const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
export const button = (action, text, style = '', attrs = '') => `<button class="btn ${style}" data-action="${action}" ${attrs}>${text}</button>`;
export const brand = () => `<button class="brand" data-action="home" aria-label="Полка, на главную"><span class="brandmark" aria-hidden="true"><span></span><span></span><span></span></span>полка</button>`;
