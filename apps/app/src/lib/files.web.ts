export function saveText(text: string, name: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return Promise.resolve();
}

export function pickText(accept: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file === undefined) resolve(null);
      else file.text().then(resolve, reject);
    });
    input.addEventListener('cancel', () => {
      resolve(null);
    });
    input.click();
  });
}
