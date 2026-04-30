# Fluxo operacional do validador

Este é o fluxo completo esperado para produção.

## 1. Entrada do cliente

1. Cliente abre o bot no Telegram.
2. Cliente envia `/start`.
3. Bot responde com orientação e botão para compartilhar telefone.
4. Cliente toca em `Compartilhar meu telefone`.
5. Sistema grava nome, usuário do Telegram, `chat_id` e celular real autorizado.

Observação: o Telegram não entrega celular automaticamente. O celular só aparece no painel depois que o cliente compartilha o contato.

## 2. Envio do bilhete

1. Cliente envia um código com 12 caracteres, com ou sem espaços.
2. Sistema normaliza para o formato `XXXX XXXX XXXX`.
3. Se o cliente enviar mais de um código, o bot bloqueia e pede para enviar um por vez.
4. Se não houver código válido, o bot avisa o cliente e registra o evento para o administrador.

## 3. Validação do bilhete

1. Sistema consulta o site de apostas.
2. Se o bilhete não existir, o cliente recebe aviso para conferir e reenviar.
3. Se o bilhete já estiver aberto, confirmado ou sem pré-confirmação pendente, o cliente recebe o status correto.
4. Se o bilhete estiver pendente, o sistema extrai valor, prêmio e jogos.

## 4. Regra de limite

1. Todo cliente começa com limite padrão de `R$ 150,00`.
2. Antes de confirmar, o sistema calcula:
   - limite total;
   - valor já confirmado;
   - pagamentos registrados;
   - reservas ativas;
   - valor em aberto;
   - valor disponível.
3. O bilhete só é confirmado se `valor do bilhete <= limite disponível`.
4. Quando confirma, o valor do bilhete aumenta o aberto e reduz o disponível.
5. Exemplo: limite `R$ 150,00`, bilhete `R$ 10,00`, aberto `R$ 0,00` -> disponível vira `R$ 140,00`.

## 5. Limite esgotado

1. Se não houver limite, o sistema não confirma o bilhete.
2. O cliente recebe mensagem com:
   - limite;
   - em aberto;
   - valor do bilhete;
   - disponível;
   - pagamento mínimo para liberar aquele bilhete.
3. O administrador recebe alerta real via Telegram.

Exemplo: deve `R$ 100,00`, limite `R$ 100,00`, bilhete `R$ 10,00`.
O bot pede pagamento mínimo de `R$ 10,00`.

## 6. Pagamento parcial

1. Cliente paga ao administrador.
2. Administrador abre o painel.
3. No cliente correto, informa o valor em `Valor pago` e clica em `Registrar`.
4. Sistema baixa somente o valor pago.
5. Exemplo: deve `R$ 100,00`, pagou `R$ 50,00` -> em aberto `R$ 50,00`, disponível `R$ 50,00`.
6. O cliente só consegue confirmar bilhetes até o valor disponível.

## 7. Confirmação

1. Se o limite permitir, o sistema confirma o pré-bilhete no site.
2. Cliente recebe mensagem de sucesso.
3. Cliente recebe comprovante quando houver screenshot.
4. Administrador recebe notificação real via Telegram.
5. Dashboard atualiza com dados do cliente, bilhete, jogos, valor, prêmio, status e financeiro.

## 8. Notificações do administrador

Para receber alertas reais no Telegram, o administrador deve abrir o bot e enviar:

```text
/admin sua-senha-do-painel
```

Depois disso o sistema grava o Telegram do administrador no banco e passa a notificar:

- bilhete confirmado;
- bilhete não localizado;
- erro de validação;
- limite excedido;
- cliente com limite quase atingido;
- código inválido;
- mais de um código na mesma mensagem;
- celular cadastrado ou recusado.

O painel também tem a ação `Enviar teste` para confirmar que o Telegram administrativo está recebendo de verdade.

## 9. Painel administrativo

O painel deve mostrar:

- nome do cliente;
- ID Telegram/contato;
- celular compartilhado;
- bilhetes enviados;
- bilhetes confirmados;
- jogos por bilhete;
- valor total;
- limite;
- em aberto;
- disponível;
- pagamentos;
- reservas;
- erro ou status de cada bilhete.

O administrador tambem pode apagar dados de teste diretamente pelo painel:

- apagar uma solicitacao especifica em `Detalhes completos`;
- limpar todos os dados operacionais em `Limpeza operacional`;
- confirmar qualquer exclusao digitando a senha do administrador.

A limpeza remove bilhetes, clientes, limites e pagamentos cadastrados. Ela nao altera a estrutura do banco, o login do administrador nem os logs de seguranca.

## 10. Checklist antes de uso real

Rodar:

```bash
npm run check
npm run build
npm run check:money
npm run check:credit
npm run check:flow
npm run check:responsive
```

Depois conferir:

1. Vercel deploy em `Ready`.
2. `/api/admin` abrindo com login.
3. Bot Telegram respondendo `/start`.
4. Cliente teste compartilhando telefone.
5. Um código válido confirmando quando houver limite.
6. Um cliente sem limite sendo bloqueado.
7. Pagamento parcial liberando só o valor pago.
