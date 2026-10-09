// Keep the address encoded until a visitor explicitly reveals it.
document.querySelectorAll('[data-email-reveal]').forEach(button => {
  button.addEventListener('click', () => {
    const address = atob('Z3BsYXlAZDNzb3gubWU=');
    const link = document.createElement('a');
    link.href = 'mailto:' + address;
    link.textContent = address;
    button.replaceWith(link);
    link.focus();
  }, { once: true });
  button.hidden = false;
});
