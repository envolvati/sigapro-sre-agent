import { DailyDigestUseCase } from '../usecases/daily-digest.js';

async function main() {
  console.log('🤖 Disparando Daily SRE Digest via CLI...');
  const useCase = new DailyDigestUseCase();
  const result = await useCase.execute();

  if (result.success) {
    console.log('\n✅ Daily Digest enviado com sucesso para o Telegram!\n');
    console.log(result.digest);
  } else {
    console.error('\n❌ Falha ao enviar Daily Digest:', result.error);
    process.exit(1);
  }
}

main();
