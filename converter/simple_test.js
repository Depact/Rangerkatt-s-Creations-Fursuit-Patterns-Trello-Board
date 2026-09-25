const pull = async (url, dest) => {
    console.log(`Fetching: ${url}`);
    return Promise.resolve(Buffer.from('test'));
};

(async () => {
    console.log('Test call:');
    await pull('http://example.com/test.jpg', 'test.jpg');
})();