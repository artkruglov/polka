const button = document.getElementById('period');
button.addEventListener('click', () => {
  const previous = button.getAttribute('aria-pressed') !== 'true';
  button.setAttribute('aria-pressed', String(previous));
  document.getElementById('completed').textContent = previous ? '9' : '12';
  document.getElementById('meetings').textContent = previous ? '11' : '8';
  document.getElementById('status').textContent = previous ? 'Прошлая неделя' : 'Текущая неделя';
  button.textContent = previous ? 'Показать текущую неделю' : 'Показать прошлую неделю';
});
