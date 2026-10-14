// Keep the address encoded until a visitor explicitly reveals it.
document.querySelectorAll('[data-email-reveal]').forEach(button => {
  button.addEventListener('click', () => {
    const address = String.fromCharCode(...'64.56.58.61.5f.52.5h.37.55.2d.61.5g.66.28.5e.56'.split('.').map(value => parseInt(value, 19)));
    const link = document.createElement('a');
    link.href = 'mailto:' + address;
    link.textContent = address;
    button.replaceWith(link);
    link.focus();
  }, { once: true });
  button.hidden = false;
});
