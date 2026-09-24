async function attemptLogin() {
  const username = document.getElementById('username').value.trim();
  const pin = document.getElementById('pin').value.trim();
  const errorMsg = document.getElementById('errorMsg');

  const user = await window.api.auth.login(username, pin);
  if (!user) {
    errorMsg.textContent = 'اسم المستخدم أو الرقم السري غير صحيح';
    errorMsg.style.display = 'block';
    return;
  }
  await window.api.nav.goToApp();
}

document.getElementById('loginBtn').addEventListener('click', attemptLogin);
document.getElementById('pin').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') attemptLogin();
});
