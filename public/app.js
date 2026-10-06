document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-loading-form')) return;
  const submit = form.querySelector('button[type="submit"]');
  if (!submit) return;
  submit.disabled = true;
  const status = document.createElement('p');
  status.className = 'loading-state';
  status.setAttribute('role', 'status');
  status.textContent = 'Saving…';
  form.append(status);
});
