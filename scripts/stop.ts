import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const PID_FILE = path.resolve('.bot.pid');

function stopByPidFile(): void {
  if (!fs.existsSync(PID_FILE)) {
    console.log('PID-файл не найден. Возможно, бот уже остановлен.');
    return;
  }

  const raw = fs.readFileSync(PID_FILE, { encoding: 'utf8' }).trim();
  const pid = Number(raw);
  if (!pid || Number.isNaN(pid)) {
    console.log(`Некорректный PID в файле: "${raw}"`);
    fs.unlinkSync(PID_FILE);
    return;
  }

  try {
    process.kill(pid, 'SIGINT');
    console.log(`Отправлен SIGINT процессу ${pid}.`);
  } catch (e) {
    console.log(`Не удалось отправить сигнал процессу ${pid}:`, e);
  }
}

function killAllNodeProcesses(): void {
  try {
    // Специально для Windows/PowerShell: эквивалент команды
    // Get-Process node | Stop-Process -Force
    execSync('powershell -Command "Get-Process node | Stop-Process -Force"', {
      stdio: 'inherit',
    });
  } catch (e) {
    console.log('Не удалось завершить все процессы node (возможно, их уже нет):', e);
  }
}

function main(): void {
  // Сначала пробуем корректно остановить бот по PID-файлу.
  stopByPidFile();

  // Затем на всякий случай убиваем все процессы node, как ты просил.
  killAllNodeProcesses();
}

main();

