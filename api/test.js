module.exports = (req, res) => {
  const hasKey = !!process.env.OPENROUTER_API_KEY;
  res.status(200).json({
    ok: true,
    message: 'Серверная функция работает!',
    keyFound: hasKey
  });
};
