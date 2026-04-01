<h1 align="center">
  <br>
  <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" alt="ZapMax" width="100">
  <br>
  ZapMax - Sistema de Gestão Multi-Atendentes para WhatsApp 🚀
</h1>

<p align="center">
  <a href="#-visão-geral">Visão Geral</a> •
  <a href="#-principais-funcionalidades">Funcionalidades</a> •
  <a href="#-arquitetura-e-stack">Tecnologias</a> •
  <a href="#-como-rodar-o-projeto">Como Rodar</a>
</p>

---

## 📖 Visão Geral

**ZapMax** é uma plataforma robusta projetada para equipes de atendimento via WhatsApp. Criado pensando em escalabilidade e velocidade, o sistema permite que múltiplos atendentes utilizem um único número de WhatsApp de forma organizada, em tempo real e com controle total dos administradores. 

Totalmente isolado do aparelho físico, o sistema se comunica diretamente por meio da API do WhatsApp Web (`wwebjs`) e fornece acesso através de um painel de gerenciamento moderno, disponível em formato Desktop (Electron) e Web.

---

## ✨ Principais Funcionalidades

### 💬 Atendimento Multi-Usuário (Filas e Transbordos)
- **Múltiplos Atendentes Simultâneos:** Todos recebem, enviam e acompanham mensagens em tempo real no mesmo número.
- **Transferência Inteligente:** Repasse o cliente para outro departamento/usuário e transfira a notificação visual (badges de não-lido) diretamente para o colega.
- **Visibilidade de Convidados:** Atendentes convidados para uma conversa em andamento conseguem interagir com clientes mesmo não sendo os donos principais do ticket.

### 🤖 Automação e Bots
- **Respostas Automatizadas:** Configuração de "mensagens de ausência" (ex: horário de almoço) e "boas-vindas".
- **Gatilhos por Palavra-Chave:** O sistema identifica gatilhos textuais enviados pelos clientes e dispara roteiros automáticos ou envia arquivos previamente configurados.

### 📊 Painel Admin e Gestão (Mini-CRM)
- **Gestão de Contatos (Guia):** Diretório e agenda sincronizada da empresa que suporta buscas avançadas, visualização e armazenamento de avatares dos clientes em disco para performance extrema.
- **Exportação Fácil:** Exporte sua base de clientes com 1 clique para integração corporativa (padrão Google Contacts em .CSV).
- **Ações em Massa (Bulk Actions):** Selecione múltiplos tickets/chats apertando `Ctrl + Clique` e aplique ações em massa (como cancelar conexões presas ou marcar como concluído).
- **Painel Administrativo Embutido:** Deslize as abas do sistema para configurar sua agência, usuários e opções gerenciais através da própria interface do usuário (sem ter que sair da sua tela).

### 🛠 Gestão Avançada de Mensagens
- **Edição e Exclusão Reais:** Edite e apague as mensagens dentro do painel do ZapMax de forma que tudo seja refletido também dentro do próprio WhatsApp oficial.
- **Ciclo de Vida do Atendimento:** Feche tickets quando a conversa acabar. Eles poderão ser facilmente reabertos se e quando o cliente mandar mensagem novamente.

---

## 🏗 Arquitetura e Stack

Este projeto é segmentado para operar tanto de forma client/server quanto embutido (Desktop Electron).

* **Backend / Engine:** Node.js com Express e `whatsapp-web.js` (responsável por gerenciar a sessão do WhatsApp como um navegador headless).
* **Tempo Real:** Socket.IO para sincronizar todas as abas, novos chats e mensagens lidas sem necessidade de atualizar a tela (F5).
* **Banco de Dados:** SQLite, focado em agilidade, utilizando otimizações locais intensivas (WAL mode e indexação avançada). O banco se divide em dados textuais de conversação (`.sqlite`) e armazenamento binário local para fotos e mídias.
* **Frontend e Desktop:** Empacotamento multi-plataforma usando o `Electron` e o `electron-builder`.

---

## 🚀 Como Rodar o Projeto

### Pré-requisitos
> * Requer **Node.js** (v18+ recomendado).
> * Requer **Git** instalado.

1. **Clone o repositório:**
   ```bash
   git clone https://github.com/tangoplaybr/zapmax.git
   cd zapmax
   ```

2. **Instale as dependências:**
   ```bash
   npm install
   ```

3. **Inicie o Servidor Node (Backend):**
   ```bash
   npm run start:server
   ```
   *No primeiro acesso, um QR Code será gerado no terminal para parear o WhatsApp!*

4. **Inicie o Sistema Visual (Frontend Desktop):**
   ```bash
   npm run start:client
   ```

5. **Gerando Builds de Produção (.exe/.dmg):**
   * Backend: `npm run build:server`
   * Frontend: `npm run build:client`

---

> Desenvolvido primariamente para uso próprio / gerencial corporativo de atendimento. 🚀
